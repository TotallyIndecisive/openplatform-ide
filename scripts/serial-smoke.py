"""Read-only hardware smoke check using PlatformIO's Python/pyserial."""
import argparse
import time
import serial

parser = argparse.ArgumentParser()
parser.add_argument('--port', required=True)
args = parser.parse_args()
connection = serial.Serial()
connection.port = args.port
connection.baudrate = 115200
connection.timeout = 0.25
connection.dtr = False
connection.rts = False
connection.open()
try:
    deadline = time.monotonic() + 5
    captured = bytearray()
    while time.monotonic() < deadline:
        captured.extend(connection.read(4096))
    text = captured.decode('utf-8', errors='replace')
    print(text)
    assert 'GPIO 23: on' in text and 'GPIO 23: off' in text, 'Expected both LED states from firmware'
finally:
    connection.close()
