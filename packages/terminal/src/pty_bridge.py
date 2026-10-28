"""Bridge a pseudo-terminal to stdin/stdout.

`script(1)` refuses to run when its stdio is a pipe, so the harness spawns this
helper instead: it forks the shell on a pty and relays bytes. Resize requests
arrive as NUL-prefixed control lines, which a keyboard cannot produce.

usage: python3 pty.py <shell>
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios

shell = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SHELL", "/bin/sh")
cols = int(os.environ.get("COLUMNS", "80"))
rows = int(os.environ.get("LINES", "24"))
RESIZE = b"\x00resize:"

pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, "-i"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pending = b""
try:
    while True:
        try:
            ready, _, _ = select.select([fd, 0], [], [])
        except InterruptedError:
            continue
        except OSError:
            break

        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)

        if 0 in ready:
            try:
                data = os.read(0, 65536)
            except OSError:
                break
            if not data:
                try:
                    os.write(fd, b"\x04")
                except OSError:
                    pass
                break
            pending += data

            while pending:
                if pending.startswith(RESIZE):
                    end = pending.find(b"\n")
                    if end < 0:
                        break
                    try:
                        rows_arg, cols_arg = pending[len(RESIZE):end].decode().split(":")
                        fcntl.ioctl(
                            fd,
                            termios.TIOCSWINSZ,
                            struct.pack("HHHH", int(rows_arg), int(cols_arg), 0, 0),
                        )
                    except (ValueError, OSError):
                        pass
                    pending = pending[end + 1:]
                    continue

                nul = pending.find(b"\x00")
                if nul > 0:
                    os.write(fd, pending[:nul])
                    pending = pending[nul:]
                    continue
                if nul == 0:
                    os.write(fd, b"\x00")
                    pending = pending[1:]
                    continue
                os.write(fd, pending)
                pending = b""
finally:
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
