#!/usr/bin/env python3
"""Forward a local port to the rig, so a desktop browser can use the camera.

`getUserMedia()` is only offered to a secure context. The rig speaks plain HTTP
on its own access point, so a browser pointed at http://192.168.4.1/ will not
give the page a camera — but `http://localhost` is treated as a secure context
by every browser, with no flags and no certificate. Forward a local port to the
rig and the dashboard is suddenly camera-eligible:

    python3 tools/rig-localhost-proxy.py
    # then open http://localhost:8080/

This is a raw TCP forwarder, not an HTTP proxy: it copies bytes in both
directions and never looks at them. That is what lets the WebSocket upgrade,
the gzip-encoded dashboard and the multi-megabyte MediaPipe assets pass through
untouched.

Bound to 127.0.0.1 only. Nothing on the network can reach the rig through it.
"""

import argparse
import socket
import socketserver
import sys
import threading


def pump(src: socket.socket, dst: socket.socket) -> None:
    """Copy until one side hangs up, then half-close so the other side sees EOF."""
    try:
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


class Handler(socketserver.BaseRequestHandler):
    rig_host = "192.168.4.1"
    rig_port = 80

    def handle(self) -> None:
        try:
            upstream = socket.create_connection((self.rig_host, self.rig_port), timeout=10)
        except OSError as err:
            print(f"  rig unreachable: {err}", file=sys.stderr)
            return
        # No timeout once connected: the live WebSocket is idle between IMU
        # batches and a read deadline would tear it down mid-session.
        upstream.settimeout(None)
        self.request.settimeout(None)
        with upstream:
            up = threading.Thread(target=pump, args=(self.request, upstream), daemon=True)
            up.start()
            pump(upstream, self.request)
            up.join()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8080, help="local port (default 8080)")
    ap.add_argument("--rig", default="192.168.4.1", help="rig address (default 192.168.4.1)")
    ap.add_argument("--rig-port", type=int, default=80, help="rig port (default 80)")
    args = ap.parse_args()

    Handler.rig_host = args.rig
    Handler.rig_port = args.rig_port

    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError as err:
        print(f"cannot listen on 127.0.0.1:{args.port}: {err}", file=sys.stderr)
        return 1

    print(f"http://localhost:{args.port}/  ->  {args.rig}:{args.rig_port}")
    print("secure context, so the camera works without HTTPS. Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
