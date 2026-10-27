//! Source-control workflows. Git and gh own credentials; the IDE never reads tokens.
use std::{path::{Path, PathBuf}, process::{Command, Output}, sync::{Arc, atomic::{AtomicBool, Ordering}}, io::Read, thread};
use serde::Serialize;
use tauri::{Emitter, Manager};
use crate::{TerminalSession, home};

#[derive(Default)]
pub struct AuthState { session: std::sync::Mutex<Option<(String,TerminalSession)>> }

fn gh() -> Result<PathBuf, String> {
    crate::tooling::resolve(if cfg!(windows) { "gh.exe" } else { "gh" }, "GH_PATH", &[PathBuf::from("/opt/homebrew/bin/gh"), PathBuf::from("/usr/local/bin/gh"), PathBuf::from("/usr/bin/gh")])
}
fn result(out: Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    serde_json::json!({"success":out.status.success(), "output":stdout, "error":stderr})
}
fn git(dir: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git").current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").args(args).output().map_err(|e| format!("Could not run Git: {e}"))
}
fn root(dir: &str) -> Result<PathBuf, String> {
    let out=git(Path::new(dir), &["rev-parse", "--show-toplevel"])?;
    if !out.status.success() { return Err("This project is not in a Git repository. Initialize one to begin.".into()); }
    Ok(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
}
fn require_ok(out: Output) -> Result<Output, String> {
    if out.status.success() { Ok(out) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}
fn safe_path(path: &str) -> Result<(), String> {
    if path.is_empty() || Path::new(path).is_absolute() || Path::new(path).components().any(|c| !matches!(c,std::path::Component::Normal(_))) { return Err("Invalid repository path".into()); }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct FileChange { path: String, original_path: Option<String>, index: char, worktree: char, conflict: bool }
fn parse_status(bytes: &[u8]) -> Vec<FileChange> {
    let mut fields=bytes.split(|b| *b==0); let mut changes=Vec::new();
    while let Some(rec)=fields.next() {
        if rec.len()<4 { continue; }
        let index=rec[0] as char; let worktree=rec[1] as char;
        let path=String::from_utf8_lossy(&rec[3..]).to_string();
        let original_path=if index=='R'||index=='C'||worktree=='R'||worktree=='C' { fields.next().map(|s|String::from_utf8_lossy(s).to_string()) } else { None };
        let conflict=matches!((index,worktree),('D','D')|('A','U')|('U','D')|('U','A')|('D','U')|('A','A')|('U','U'));
        changes.push(FileChange {path, original_path, index, worktree, conflict});
    }
    changes
}
#[tauri::command]
pub async fn sc_status(project_dir: String) -> Result<serde_json::Value,String> {
    tauri::async_runtime::spawn_blocking(move || {
        if project_dir.is_empty() { return Err("Open a project first.".into()); }
        let probe=git(Path::new(&project_dir), &["rev-parse", "--show-toplevel"])?;
        if !probe.status.success() {
            let error=String::from_utf8_lossy(&probe.stderr).trim().to_owned();
            if error.contains("not a git repository") {return Ok(serde_json::json!({"initialized":false}));}
            return Err(if error.is_empty() {"Could not inspect this repository.".into()} else {error});
        }
        let dir=PathBuf::from(String::from_utf8_lossy(&probe.stdout).trim());
        let status=require_ok(git(&dir,&["status","--porcelain=v1","-z","--untracked-files=all"])?)?;
        let branch=git(&dir,&["branch","--show-current"])?;
        let branches=git(&dir,&["for-each-ref","--format=%(refname:short)","refs/heads/"])?;
        let upstream=git(&dir,&["rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}"])?;
        let head=git(&dir,&["rev-parse","--verify","HEAD"])?;
        let origin=git(&dir,&["remote","get-url","origin"])?;
        let identity_name=git(&dir,&["config","user.name"])?; let identity_email=git(&dir,&["config","user.email"])?;
        let history=git(&dir,&["log","-20","--format=%h%x09%s"])?;
        let counts=if upstream.status.success() { git(&dir,&["rev-list","--left-right","--count","HEAD...@{upstream}"])?.stdout } else {Vec::new()};
        let counts=String::from_utf8_lossy(&counts).split_whitespace().filter_map(|x|x.parse::<usize>().ok()).collect::<Vec<_>>();
        Ok(serde_json::json!({"initialized":true,"root":dir,"branch":String::from_utf8_lossy(&branch.stdout).trim(),"branches":String::from_utf8_lossy(&branches.stdout).lines().collect::<Vec<_>>(),"upstream":String::from_utf8_lossy(&upstream.stdout).trim(),"hasCommit":head.status.success(),"remote":String::from_utf8_lossy(&origin.stdout).trim(),"name":String::from_utf8_lossy(&identity_name.stdout).trim(),"email":String::from_utf8_lossy(&identity_email.stdout).trim(),"changes":parse_status(&status.stdout),"history":String::from_utf8_lossy(&history.stdout).lines().map(str::to_owned).collect::<Vec<_>>(),"ahead":counts.first().copied().unwrap_or(0),"behind":counts.get(1).copied().unwrap_or(0)}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn sc_account() -> Result<serde_json::Value,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe=match gh() {Ok(x)=>x,Err(e)=>return Ok(serde_json::json!({"available":false,"error":e}))};
        // Restrict gh output to non-secret fields. Never ask gh for tokens.
        let out=Command::new(&exe).env("GH_PROMPT_DISABLED","1").args(["auth","status","--hostname","github.com","--active","--json","hosts","--jq", ".hosts[\"github.com\"][]? | select(.active) | {login, state}"]).output().map_err(|e|e.to_string())?;
        if !out.status.success() {return Ok(serde_json::json!({"available":true,"authenticated":false}));}
        let entry:serde_json::Value=serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null);
        let login=entry["login"].as_str().unwrap_or("");
        let state=entry["state"].as_str().unwrap_or("");
        Ok(serde_json::json!({"available":true,"authenticated":state=="success", "login":login}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn sc_switch_account(login:String) -> Result<serde_json::Value,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let login=login.trim();
        if login.is_empty() || login.starts_with('-') || !login.chars().all(|c| c.is_ascii_alphanumeric() || c=='-') {return Err("Enter a valid GitHub username.".into());}
        let out=Command::new(gh()?).env("GH_PROMPT_DISABLED","1").args(["auth","switch","--hostname","github.com","--user",login]).output().map_err(|e|e.to_string())?;
        Ok(result(out))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn sc_action(project_dir:String, action:String, value:Option<String>, path:Option<String>, original_path:Option<String>, private:Option<bool>, staged:Option<bool>, description:Option<String>, author_name:Option<String>, author_email:Option<String>) -> Result<serde_json::Value,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project=PathBuf::from(&project_dir); if !project.is_dir(){return Err("Open a project first.".into());}
        if action=="init" {return Ok(result(git(&project,&["init"]) ?));}
        let dir=root(&project_dir)?; let val=value.as_deref().unwrap_or("");
        let out=match action.as_str() {
            "stage"|"unstage" => {
                let path=path.as_deref().ok_or("Choose a file.")?;safe_path(path)?;
                if let Some(p)=original_path.as_deref(){safe_path(p)?;}
                let mut args=if action=="stage" {vec!["--literal-pathspecs","add","-A","--"]} else {vec!["--literal-pathspecs","reset","--quiet","HEAD","--"]};
                if action=="unstage" && !git(&dir,&["rev-parse","--verify","HEAD"])?.status.success() {args=vec!["--literal-pathspecs","rm","--cached","-r","--ignore-unmatch","--"];}
                args.push(path); if let Some(p)=original_path.as_deref(){args.push(p);} git(&dir,&args)?
            },
            "stage_all"=>git(&dir,&["add","-A","--","."])?,
            "unstage_all"=>if git(&dir,&["rev-parse","--verify","HEAD"])?.status.success(){git(&dir,&["reset","--quiet","HEAD","--","."])?}else{git(&dir,&["rm","--cached","-r","--ignore-unmatch","--","."])?},
            "commit"=>{
                if val.trim().is_empty(){return Err("Enter a commit message.".into());}
                match (author_name.as_deref(),author_email.as_deref()) {
                    (Some(name),Some(email)) if !name.trim().is_empty() && !email.trim().is_empty() && !name.contains('\n') && !email.contains('\n') => {
                        let n=format!("user.name={}",name.trim());let e=format!("user.email={}",email.trim());git(&dir,&["-c",&n,"-c",&e,"commit","-m",val])?
                    },
                    (None,None)=>git(&dir,&["commit","-m",val])?,
                    _=>return Err("Enter a valid Git author name and email in Accounts settings.".into()),
                }
            },
            "identity"=>{let email=description.as_deref().unwrap_or("");if val.trim().is_empty()||email.trim().is_empty()||val.contains('\n')||email.contains('\n'){return Err("Enter a name and email for this repository.".into());} require_ok(git(&dir,&["config","--local","user.name",val.trim()])?)?;git(&dir,&["config","--local","user.email",email.trim()])?},
            "checkout"=>{if val.starts_with('-')||val.is_empty(){return Err("Choose a branch.".into());}git(&dir,&["switch","--",val])?},
            "create_branch"=>{if val.starts_with('-')||val.is_empty(){return Err("Enter a branch name.".into());}git(&dir,&["switch","-c",val])?},
            "fetch"|"push"|"pull" => {
                let mut cmd=Command::new("git");cmd.current_dir(&dir).env("GIT_TERMINAL_PROMPT","0");
                // Use gh's credential helper only for github.com, without changing global Git configuration.
                if let Ok(exe)=gh() { let helper=format!("!\"{}\" auth git-credential",exe.display()); cmd.args(["-c","credential.https://github.com.helper=","-c",&format!("credential.https://github.com.helper={helper}")]); }
                match action.as_str(){"fetch"=>{cmd.args(["fetch","--prune"]);},"pull"=>{cmd.args(["pull","--ff-only"]);},_=>{
                    let upstream=git(&dir,&["rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}"])?;
                    if upstream.status.success(){cmd.arg("push");}else{let branch=String::from_utf8_lossy(&git(&dir,&["branch","--show-current"])?.stdout).trim().to_owned();if branch.is_empty(){return Err("Cannot push a detached HEAD. Switch to a branch first.".into());}cmd.args(["push","--set-upstream","origin",&branch]);}
                }}
                cmd.output().map_err(|e|e.to_string())?
            },
            "remote_add"=>{if val.is_empty()||val.starts_with('-'){return Err("Enter a remote URL.".into());}git(&dir,&["remote","add","origin",val])?},
            "publish"=>{
                if val.is_empty()||val.starts_with('-')||val.contains('/') {return Err("Enter a repository name without an owner or slash.".into());}
                if git(&dir,&["remote","get-url","origin"])?.status.success(){return Err("An origin remote already exists. Push to it or remove it in Git before publishing a new repository.".into());}
                if !git(&dir,&["rev-parse","--verify","HEAD"])?.status.success(){return Err("Create an initial commit before publishing.".into());}
                let exe=gh()?; let visibility=if private.unwrap_or(true){"--private"}else{"--public"};
                let mut cmd=Command::new(exe);cmd.current_dir(&dir).env("GH_PROMPT_DISABLED","1").args(["repo","create",val,visibility,"--source",".","--remote","origin"]);
                if let Some(desc)=description.as_deref().filter(|s|!s.trim().is_empty()){cmd.args(["--description",desc]);}
                cmd.output().map_err(|e|e.to_string())?
            },
            "diff"=>{
                let p=path.as_deref().ok_or("Choose a file.")?;safe_path(p)?;
                let mut args=if staged.unwrap_or(false){vec!["--literal-pathspecs","diff","--no-ext-diff","--cached","--",p]}else{vec!["--literal-pathspecs","diff","--no-ext-diff","--",p]};
                if let Some(original)=original_path.as_deref(){safe_path(original)?;args.push(original);}
                let out=git(&dir,&args)?;
                if out.status.success() && out.stdout.is_empty() && !staged.unwrap_or(false) {
                    let file=dir.join(p);let root_c=dir.canonicalize().map_err(|e|e.to_string())?;let f=file.canonicalize().map_err(|e|e.to_string())?;
                    if !f.starts_with(root_c){return Err("File is outside this repository.".into());}let mut buf=Vec::new();std::fs::File::open(f).map_err(|e|e.to_string())?.take(131072).read_to_end(&mut buf).map_err(|e|e.to_string())?;
                    return Ok(serde_json::json!({"success":true,"output":format!("Untracked file: {p}\n\n{}",String::from_utf8_lossy(&buf))}));
                } out
            },
            _=>return Err("Unknown source-control action.".into())
        };
        if out.status.success() && (action=="unstage" || action=="unstage_all") {
            return Ok(serde_json::json!({"success":true,"output":"Changes unstaged. Working files were kept."}));
        }
        Ok(result(out))
    }).await.map_err(|e|e.to_string())?
}

/// A dedicated PTY keeps interactive gh sign-in separate from the user's shell.
#[tauri::command]
pub fn sc_auth_start(app:tauri::AppHandle,state:tauri::State<AuthState>, session_id:String) -> Result<(),String> {
    let exe=gh()?; let mut guard=state.session.lock().map_err(|e|e.to_string())?;
    if guard.is_some(){return Err("A sign-in session is already open.".into());}
    let pair=portable_pty::native_pty_system().openpty(portable_pty::PtySize{rows:12,cols:75,pixel_width:0,pixel_height:0}).map_err(|e|e.to_string())?;
    let mut cmd=portable_pty::CommandBuilder::new(exe);cmd.args(["auth","login","--hostname","github.com","--git-protocol","https","--web"]);cmd.cwd(home());cmd.env("TERM","xterm-256color");
    let child=pair.slave.spawn_command(cmd).map_err(|e|e.to_string())?;drop(pair.slave);
    let mut reader=pair.master.try_clone_reader().map_err(|e|e.to_string())?;let writer=pair.master.take_writer().map_err(|e|e.to_string())?;let stop=Arc::new(AtomicBool::new(false));let stopped=stop.clone();
    let event_id=session_id.clone();
    *guard=Some((session_id,TerminalSession{writer,master:pair.master,child,stop}));
    drop(guard);
    thread::spawn(move || {
        let mut buf=[0u8;4096];
        while !stopped.load(Ordering::SeqCst){match reader.read(&mut buf){Ok(0)|Err(_)=>break,Ok(n)=>{let _=app.emit("sc-auth-data",serde_json::json!({"sessionId":event_id,"data":String::from_utf8_lossy(&buf[..n])}));}}}
        if !stopped.load(Ordering::SeqCst){
            let success=app.state::<AuthState>().session.lock().ok().and_then(|mut g|g.as_mut().and_then(|(id,s)|if *id==event_id {s.child.wait().ok().map(|status|status.success())} else {None})).unwrap_or(false);
            let _=app.emit("sc-auth-exit",serde_json::json!({"sessionId":event_id,"success":success}));
        }
    });
    Ok(())
}
#[tauri::command]
pub fn sc_auth_write(state:tauri::State<AuthState>, session_id:String, data:String)->Result<(),String>{use std::io::Write;let mut guard=state.session.lock().map_err(|e|e.to_string())?;let (id,s)=guard.as_mut().ok_or("No sign-in session")?;if *id!=session_id{return Err("Sign-in session has ended".into());}s.writer.write_all(data.as_bytes()).map_err(|e|e.to_string())?;s.writer.flush().map_err(|e|e.to_string())}
pub fn stop_auth(state:&AuthState){if let Ok(mut g)=state.session.lock(){if let Some((_,mut s))=g.take(){s.stop.store(true,Ordering::SeqCst);let _=s.child.kill();let _=s.child.wait();}}}
#[tauri::command]
pub fn sc_auth_stop(state:tauri::State<AuthState>, session_id:String){if let Ok(mut g)=state.session.lock(){if g.as_ref().is_some_and(|(id,_)|*id==session_id){if let Some((_,mut s))=g.take(){s.stop.store(true,Ordering::SeqCst);let _=s.child.kill();let _=s.child.wait();}}}}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn status_handles_spaces_renames_and_conflicts(){let v=parse_status(b" M file with space\0R  new name\0old name\0UU conflict\0?? new\0");assert_eq!(v.len(),4);assert_eq!(v[0].path,"file with space");assert_eq!(v[1].original_path.as_deref(),Some("old name"));assert!(v[2].conflict);assert_eq!(v[3].index,'?');}
 #[test] fn path_validation_prevents_escape(){assert!(safe_path("dir/a b.cpp").is_ok());assert!(safe_path("../outside").is_err());assert!(safe_path("/tmp/outside").is_err());}
}

#[cfg(test)]
mod workflow_tests {
    use super::*;
    use std::fs;
    fn action(project: &str, op: &str, value: Option<&str>, path: Option<&str>) -> serde_json::Value {
        tauri::async_runtime::block_on(sc_action(project.into(), op.into(), value.map(str::to_owned), path.map(str::to_owned), None, None, None, None, None, None)).unwrap()
    }
    fn command(path: &Path, args: &[&str]) { let output=git(path,args).unwrap(); assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr)); }
    #[test]
    fn isolated_repository_stage_unstage_commit_and_push() {
        let temp=tempfile::tempdir().unwrap(); let project=temp.path().join("project");fs::create_dir(&project).unwrap();let dir=project.to_str().unwrap();
        assert!(action(dir,"init",None,None)["success"].as_bool().unwrap());
        command(&project,&["config","user.name","Test Author"]);command(&project,&["config","user.email","author@example.test"]);
        fs::write(project.join("one file.txt"),"first\n").unwrap();fs::write(project.join("-second.txt"),"other\n").unwrap();
        assert!(action(dir,"stage",None,Some("one file.txt"))["success"].as_bool().unwrap());
        let status=tauri::async_runtime::block_on(sc_status(dir.into())).unwrap();assert_eq!(status["changes"].as_array().unwrap().len(),2);
        assert!(action(dir,"unstage",None,Some("one file.txt"))["success"].as_bool().unwrap());assert!(project.join("one file.txt").exists());
        assert!(action(dir,"stage_all",None,None)["success"].as_bool().unwrap());
        let commit=tauri::async_runtime::block_on(sc_action(dir.into(),"commit".into(),Some("First commit".into()),None,None,None,None,None,Some("Preferred Author".into()),Some("preferred@example.test".into()))).unwrap();
        assert!(commit["success"].as_bool().unwrap(),"{commit}");
        let author=git(&project,&["log","-1","--format=%an <%ae>"]).unwrap();assert_eq!(String::from_utf8_lossy(&author.stdout).trim(),"Preferred Author <preferred@example.test>");
        let config=git(&project,&["config","--local","user.name"]).unwrap();assert_eq!(String::from_utf8_lossy(&config.stdout).trim(),"Test Author");
        let main_branch=tauri::async_runtime::block_on(sc_status(dir.into())).unwrap()["branch"].as_str().unwrap().to_owned();
        assert!(action(dir,"create_branch",Some("feature/test"),None)["success"].as_bool().unwrap());
        assert!(action(dir,"checkout",Some(&main_branch),None)["success"].as_bool().unwrap());
        fs::write(project.join("-second.txt"),"updated\n").unwrap();
        let diff=tauri::async_runtime::block_on(sc_action(dir.into(),"diff".into(),None,Some("-second.txt".into()),None,None,Some(false),None,None,None)).unwrap();
        assert!(diff["output"].as_str().unwrap().contains("+updated"));
        assert!(action(dir,"stage",None,Some("-second.txt"))["success"].as_bool().unwrap());
        assert!(action(dir,"unstage",None,Some("-second.txt"))["success"].as_bool().unwrap());
        assert_eq!(fs::read_to_string(project.join("-second.txt")).unwrap(),"updated\n");
        let bare=temp.path().join("remote.git");let init=Command::new("git").args(["init","--bare",bare.to_str().unwrap()]).output().unwrap();assert!(init.status.success());
        assert!(action(dir,"remote_add",Some(bare.to_str().unwrap()),None)["success"].as_bool().unwrap());
        let pushed=action(dir,"push",None,None);assert!(pushed["success"].as_bool().unwrap(),"{pushed}");
        let status=tauri::async_runtime::block_on(sc_status(dir.into())).unwrap();assert!(!status["upstream"].as_str().unwrap().is_empty());
        let clone=temp.path().join("second");
        let clone_out=Command::new("git").args(["clone",bare.to_str().unwrap(),clone.to_str().unwrap()]).output().unwrap();assert!(clone_out.status.success());
        command(&clone,&["config","user.name","Second Author"]);command(&clone,&["config","user.email","second@example.test"]);
        fs::write(clone.join("remote.txt"),"remote update\n").unwrap();command(&clone,&["add","--","remote.txt"]);command(&clone,&["commit","-m","Remote update"]);command(&clone,&["push"]);
        let fetched=action(dir,"fetch",None,None);assert!(fetched["success"].as_bool().unwrap(),"{fetched}");
        let status=tauri::async_runtime::block_on(sc_status(dir.into())).unwrap();assert_eq!(status["behind"],1);
        let pulled=action(dir,"pull",None,None);assert!(pulled["success"].as_bool().unwrap(),"{pulled}");assert_eq!(fs::read_to_string(project.join("remote.txt")).unwrap(),"remote update\n");
        fs::write(project.join("local.txt"),"local\n").unwrap();assert!(action(dir,"stage",None,Some("local.txt"))["success"].as_bool().unwrap());assert!(action(dir,"commit",Some("Local change"),None)["success"].as_bool().unwrap());
        fs::write(clone.join("another.txt"),"remote\n").unwrap();command(&clone,&["add","--","another.txt"]);command(&clone,&["commit","-m","Another update"]);command(&clone,&["push"]);
        let divergence=action(dir,"pull",None,None);assert!(!divergence["success"].as_bool().unwrap());assert!(project.join("local.txt").exists());
        let status=tauri::async_runtime::block_on(sc_status(dir.into())).unwrap();assert_eq!(status["ahead"],1);assert_eq!(status["behind"],1);
    }
}

#[cfg(test)]
mod github_fixture_tests {
    use super::*;
    #[test]
    fn mock_account_switch_and_publish() {
        if std::env::var_os("OPENPLATFORM_TEST_MOCK_GH").is_none() { return; }
        let account=tauri::async_runtime::block_on(sc_account()).unwrap();
        assert_eq!(account["authenticated"],true);assert_eq!(account["login"],"fixture-user");
        assert!(!account.to_string().contains("token"));
        let switched=tauri::async_runtime::block_on(sc_switch_account("fixture-user".into())).unwrap();assert_eq!(switched["success"],true);
        assert!(tauri::async_runtime::block_on(sc_switch_account("-invalid".into())).is_err());
        let unknown=tauri::async_runtime::block_on(sc_switch_account("missing".into())).unwrap();assert_eq!(unknown["success"],false);
        let temp=tempfile::tempdir().unwrap();let dir=temp.path().to_str().unwrap();
        assert!(git(temp.path(),&["init"]).unwrap().status.success());
        assert!(git(temp.path(),&["config","user.name","Test"]).unwrap().status.success());
        assert!(git(temp.path(),&["config","user.email","test@example.test"]).unwrap().status.success());
        std::fs::write(temp.path().join("file.txt"),"hello\n").unwrap();
        assert!(git(temp.path(),&["add","file.txt"]).unwrap().status.success());assert!(git(temp.path(),&["commit","-m","Initial"]).unwrap().status.success());
        let publish=tauri::async_runtime::block_on(sc_action(dir.into(),"publish".into(),Some("fixture-repo".into()),None,None,Some(true),None,Some("test project".into()),None,None)).unwrap();assert_eq!(publish["success"],true,"{publish}");
        let origin=git(temp.path(),&["remote","get-url","origin"]).unwrap();assert_eq!(String::from_utf8_lossy(&origin.stdout).trim(),"https://example.invalid/fixture-repo.git");
        assert!(tauri::async_runtime::block_on(sc_action(dir.into(),"publish".into(),Some("fixture-repo".into()),None,None,Some(true),None,None,None,None)).is_err());
    }
}

#[cfg(test)]
mod live_github_tests {
    use super::*;
    use std::fs;
    fn act(dir:&str,op:&str,value:Option<&str>,path:Option<&str>)->serde_json::Value {
        tauri::async_runtime::block_on(sc_action(dir.into(),op.into(),value.map(str::to_owned),path.map(str::to_owned),None,None,None,None,None,None)).unwrap()
    }
    #[test]
    fn private_repo_create_push_fetch_and_pull() {
        let Ok(repo)=std::env::var("OPENPLATFORM_TEST_LIVE_REPO") else {return};
        assert!(repo.starts_with("openplatform-scm-test-"));
        let account=tauri::async_runtime::block_on(sc_account()).unwrap();
        assert_eq!(account["authenticated"],true,"GitHub authentication is unavailable");
        let login=account["login"].as_str().unwrap();assert!(!login.is_empty());
        let temp=tempfile::tempdir().unwrap();let project=temp.path().join("project");fs::create_dir(&project).unwrap();let dir=project.to_str().unwrap();
        let init=Command::new("git").current_dir(&project).args(["init","-b","main"]).output().unwrap();assert!(init.status.success());
        for args in [["config","user.name","OpenPlatform Test"],["config","user.email","fixture@example.test"]] {assert!(git(&project,&args).unwrap().status.success());}
        fs::write(project.join("README.md"),"Temporary OpenPlatform GitHub integration test.\n").unwrap();
        assert_eq!(act(dir,"stage_all",None,None)["success"],true);assert_eq!(act(dir,"commit",Some("Initial fixture"),None)["success"],true);
        let publish=tauri::async_runtime::block_on(sc_action(dir.into(),"publish".into(),Some(repo.clone()),None,None,Some(true),None,Some("Disposable OpenPlatform source-control integration test".into()),None,None)).unwrap();
        assert_eq!(publish["success"],true,"Repository creation failed: {publish}");
        println!("CREATED_PRIVATE_REPOSITORY={login}/{repo}");
        let pushed=act(dir,"push",None,None);assert_eq!(pushed["success"],true,"Initial push failed: {pushed}");
        let remote=Command::new(gh().unwrap()).args(["repo","view",&format!("{login}/{repo}"),"--json","isPrivate,defaultBranchRef","--jq",".isPrivate and (.defaultBranchRef.name == \"main\")"]).output().unwrap();
        assert!(remote.status.success(),"Could not inspect test repository");
        assert_eq!(String::from_utf8_lossy(&remote.stdout).trim(),"true");
        let peer=temp.path().join("peer");let url=format!("https://github.com/{login}/{repo}.git");let helper=format!("!\"{}\" auth git-credential",gh().unwrap().display());
        let clone=Command::new("git").env("GIT_TERMINAL_PROMPT","0").args(["-c","credential.https://github.com.helper=","-c",&format!("credential.https://github.com.helper={helper}"),"clone",&url,peer.to_str().unwrap()]).output().unwrap();
        assert!(clone.status.success(),"clone failed: {}",String::from_utf8_lossy(&clone.stderr));
        for args in [["config","user.name","Peer Test"],["config","user.email","peer@example.test"]] {assert!(git(&peer,&args).unwrap().status.success());}
        fs::write(peer.join("peer.txt"),"remote update\n").unwrap();assert!(git(&peer,&["add","peer.txt"]).unwrap().status.success());assert!(git(&peer,&["commit","-m","Peer update"]).unwrap().status.success());
        let peer_push=Command::new("git").current_dir(&peer).env("GIT_TERMINAL_PROMPT","0").args(["-c","credential.https://github.com.helper=","-c",&format!("credential.https://github.com.helper={helper}"),"push"]).output().unwrap();assert!(peer_push.status.success(),"peer push failed: {}",String::from_utf8_lossy(&peer_push.stderr));
        assert_eq!(act(dir,"fetch",None,None)["success"],true);assert_eq!(tauri::async_runtime::block_on(sc_status(dir.into())).unwrap()["behind"],1);
        assert_eq!(act(dir,"pull",None,None)["success"],true);assert_eq!(fs::read_to_string(project.join("peer.txt")).unwrap(),"remote update\n");
    }
}
