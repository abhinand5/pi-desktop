//! Minimal CONNECT egress proxy.
//!
//! The offline-remote story: the desktop starts this proxy on 127.0.0.1:0,
//! opens `ssh -R 127.0.0.1:P:127.0.0.1:P` to the remote box, and spawns the
//! remote agent with `HTTPS_PROXY=http://127.0.0.1:P`. All model traffic —
//! including OAuth refreshes — then rides the desktop's internet connection;
//! the remote box needs zero egress.
//!
//! CONNECT-only by design: provider APIs are HTTPS, and CONNECT requires no
//! request rewriting — the tunnel is a pure byte pipe. Plain-HTTP proxies are
//! explicitly refused (405) so a misconfigured NO_PROXY fails loudly instead
//! of silently leaking.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

use crate::error::Result;

const MAX_HEAD_BYTES: usize = 8 * 1024;

#[derive(Debug)]
pub struct EgressProxy {
    port: u16,
    shutdown: Arc<Notify>,
}

impl EgressProxy {
    /// The localhost port the remote should target.
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for EgressProxy {
    fn drop(&mut self) {
        self.shutdown.notify_one();
    }
}

/// Binds the proxy on 127.0.0.1 with an ephemeral port.
pub async fn start() -> Result<EgressProxy> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let shutdown = Arc::new(Notify::new());
    let shutdown_task = shutdown.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_task.notified() => break,
                accepted = listener.accept() => {
                    let (stream, _peer) = match accepted {
                        Ok(v) => v,
                        Err(_) => break,
                    };
                    tokio::spawn(handle_connection(stream));
                }
            }
        }
    });
    Ok(EgressProxy { port, shutdown })
}

async fn handle_connection(mut client: TcpStream) {
    // Read the request head (bounded).
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        match client.read(&mut byte).await {
            Ok(0) => return,
            Ok(_) => {
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") || head.ends_with(b"\n\n") {
                    break;
                }
                if head.len() > MAX_HEAD_BYTES {
                    return;
                }
            }
            Err(_) => return,
        }
    }
    let head_str = String::from_utf8_lossy(&head);
    let first_line = head_str.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let authority = parts.next().unwrap_or("");

    if !method.eq_ignore_ascii_case("CONNECT") {
        // Plain-HTTP proxying is deliberately unsupported; see module docs.
        let _ = client
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    }

    let target = match authority.rsplit_once(':') {
        Some((host, port)) => match port.parse::<u16>() {
            Ok(port) => (host.to_string(), port),
            Err(_) => return,
        },
        None => return, // CONNECT requires an authority with port
    };

    let mut upstream = match TcpStream::connect(target).await {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: {0}\r\n\r\n{e}", e.to_string().len());
            let _ = client.write_all(msg.as_bytes()).await;
            return;
        }
    };

    let _ = client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Local echo server standing in for an "upstream".
    async fn echo_server() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    let mut buf = [0u8; 256];
                    loop {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if sock.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        (port, handle)
    }

    #[tokio::test]
    async fn relays_connect_tunnel() {
        let (srv_port, srv) = echo_server().await;
        let proxy = start().await.unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", proxy.port())).await.unwrap();
        client
            .write_all(format!("CONNECT 127.0.0.1:{srv_port} HTTP/1.1\r\nHost: 127.0.0.1:{srv_port}\r\n\r\n").as_bytes())
            .await
            .unwrap();

        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            let n = client.read(&mut byte).await.unwrap();
            assert!(n > 0, "proxy closed during handshake");
            buf.push(byte[0]);
        }
        assert!(buf.starts_with(b"HTTP/1.1 200"), "handshake failed: {:?}", String::from_utf8_lossy(&buf));

        client.write_all(b"ping-through-tunnel").await.unwrap();
        let mut echoed = vec![0u8; "ping-through-tunnel".len()];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(echoed, b"ping-through-tunnel");

        drop(proxy);
        srv.abort();
    }

    #[tokio::test]
    async fn refuses_plain_http() {
        let proxy = start().await.unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", proxy.port())).await.unwrap();
        client
            .write_all(b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")
            .await
            .unwrap();
        let mut buf = Vec::new();
        client.read_to_end(&mut buf).await.unwrap();
        assert!(buf.starts_with(b"HTTP/1.1 405"), "expected 405, got {:?}", String::from_utf8_lossy(&buf));
    }

    #[tokio::test]
    async fn reports_502_for_unreachable_upstream() {
        let proxy = start().await.unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", proxy.port())).await.unwrap();
        client
            .write_all(b"CONNECT 127.0.0.1:1 HTTP/1.1\r\n\r\n") // port 1: nothing listens
            .await
            .unwrap();
        let mut buf = Vec::new();
        client.read_to_end(&mut buf).await.unwrap();
        assert!(buf.starts_with(b"HTTP/1.1 502"), "expected 502, got {:?}", String::from_utf8_lossy(&buf));
    }

    #[tokio::test]
    async fn drop_stops_listener() {
        let proxy = start().await.unwrap();
        let port = proxy.port();
        drop(proxy);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let result = TcpStream::connect(("127.0.0.1", port)).await;
        assert!(result.is_err(), "listener should be closed after drop");
    }
}
