// Quick check of the same serial enumeration the `list_serial_ports` command uses.
fn main() {
    for p in serialport::available_ports().unwrap_or_default() {
        println!("{:<28} {:?}", p.port_name, p.port_type);
    }
}
