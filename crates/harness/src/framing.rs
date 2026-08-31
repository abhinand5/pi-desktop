//! JSONL framing and omp v2 chunked-frame reassembly.
//!
//! RPC mode uses strict LF (`\n`) framing: lines are split on the `\n` byte
//! only — never on Unicode separators (U+2028/U+2029 are valid inside JSON
//! strings) — and an optional trailing CR is stripped. A byte cap guards
//! against runaway frames from a misbehaving child.

use std::collections::HashMap;

use tokio::io::{AsyncRead, AsyncReadExt};

use crate::error::{Error, Result};

const READ_CHUNK: usize = 8 * 1024;

/// Buffered reader producing `\n`-delimited records with a per-line byte cap.
pub struct LineReader<R> {
    inner: R,
    buf: Vec<u8>,
    eof: bool,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    pub fn new(inner: R) -> Self {
        Self { inner, buf: Vec::with_capacity(READ_CHUNK * 2), eof: false }
    }

    /// Reads the next line (LF delimiter consumed, trailing CR stripped).
    /// `Ok(None)` at clean EOF with no residual bytes; a final unterminated
    /// line is still returned (a half-written frame is data, not an error).
    pub async fn next_line(&mut self, max_bytes: u64) -> Result<Option<Vec<u8>>> {
        loop {
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
                line.pop(); // \n
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.len() as u64 > max_bytes {
                    return Err(Error::OversizedFrame { limit: max_bytes });
                }
                return Ok(Some(line));
            }
            if self.eof {
                if self.buf.is_empty() {
                    return Ok(None);
                }
                let mut line = std::mem::take(&mut self.buf);
                if line.len() as u64 > max_bytes {
                    return Err(Error::OversizedFrame { limit: max_bytes });
                }
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(line));
            }
            if self.buf.len() as u64 > max_bytes {
                // Already over the cap with no delimiter in sight — reject without
                // buffering the rest of the oversized frame.
                return Err(Error::OversizedFrame { limit: max_bytes });
            }
            let mut chunk = [0u8; READ_CHUNK];
            let n = self.inner.read(&mut chunk).await?;
            if n == 0 {
                self.eof = true;
                continue;
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
    }
}

/// Reassembles omp protocol-v2 `rpc_chunk` sequences
/// (`{"type":"rpc_chunk","chunkId":..,"index":..,"count":..,"data":"<base64>"}`)
/// into the original frame bytes. Bounded: chunk counts and total sizes are
/// capped so a hostile child cannot balloon memory.
#[derive(Default)]
pub struct ChunkReassembler {
    partials: HashMap<u64, Partial>,
    max_reassembled: u64,
}

#[derive(Debug)]
struct Partial {
    parts: Vec<Option<Vec<u8>>>,
    received: usize,
    total_bytes: u64,
}

impl ChunkReassembler {
    pub fn new(max_reassembled: u64) -> Self {
        Self { partials: HashMap::new(), max_reassembled }
    }

    /// Feeds one chunk. Returns `Some(frame)` when the sequence completes.
    /// `data` is the base64 payload.
    pub fn feed(&mut self, chunk_id: u64, index: u64, count: u64, data: &str) -> Result<Option<Vec<u8>>> {
        if count == 0 || count > 4096 {
            return Err(Error::Other(format!("rpc_chunk: bad count {count}")));
        }
        if index >= count {
            return Err(Error::Other(format!("rpc_chunk: index {index} >= count {count}")));
        }
        let decoded = base64_decode(data).ok_or_else(|| Error::Other("rpc_chunk: bad base64".into()))?;
        let partial = self.partials.entry(chunk_id).or_insert_with(|| Partial {
            parts: (0..count).map(|_| None).collect(),
            received: 0,
            total_bytes: 0,
        });
        if partial.parts.len() != count as usize {
            self.partials.remove(&chunk_id);
            return Err(Error::Other("rpc_chunk: inconsistent count for chunk id".into()));
        }
        if partial.parts[index as usize].is_some() {
            // Duplicate chunk: ignore, do not double-count.
            return Ok(None);
        }
        partial.total_bytes += decoded.len() as u64;
        if partial.total_bytes > self.max_reassembled {
            self.partials.remove(&chunk_id);
            return Err(Error::OversizedFrame { limit: self.max_reassembled });
        }
        partial.parts[index as usize] = Some(decoded);
        partial.received += 1;
        if partial.received == count as usize {
            let partial = self.partials.remove(&chunk_id).expect("just checked");
            let mut frame = Vec::with_capacity(partial.total_bytes as usize);
            for part in partial.parts {
                frame.extend_from_slice(&part.expect("all parts present"));
            }
            Ok(Some(frame))
        } else {
            Ok(None)
        }
    }

    /// Drops partials (e.g. on stream reset).
    pub fn clear(&mut self) {
        self.partials.clear();
    }
}

/// Base64 tolerant of missing padding: omp splits the encoded string at
/// chunk boundaries, so individual chunks may carry unpadded tails.
fn base64_decode(data: &str) -> Option<Vec<u8>> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    use base64::Engine as _;
    static ENGINE: GeneralPurpose =
        GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));
    ENGINE.decode(data.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    async fn lines(data: &[u8], cap: u64) -> Result<Vec<Vec<u8>>> {
        let mut r = LineReader::new(Cursor::new(data.to_vec()));
        let mut out = Vec::new();
        while let Some(l) = r.next_line(cap).await? {
            out.push(l);
        }
        Ok(out)
    }

    #[tokio::test]
    async fn splits_on_lf_only_and_strips_cr() {
        // U+2028 (e2 80 a8) inside the string must NOT split the record.
        let data = b"{\"s\":\"a\xe2\x80\xa8b\"}\r\nsecond\n\n";
        let out = lines(data, 1024).await.unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], b"{\"s\":\"a\xe2\x80\xa8b\"}".to_vec());
        assert_eq!(out[1], b"second".to_vec());
        assert_eq!(out[2], b"".to_vec());
    }

    #[tokio::test]
    async fn returns_residual_final_line_without_lf() {
        let out = lines(b"one\ntwo", 1024).await.unwrap();
        assert_eq!(out, vec![b"one".to_vec(), b"two".to_vec()]);
    }

    #[tokio::test]
    async fn empty_input_is_clean_eof() {
        assert!(lines(b"", 1024).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_oversized_frame() {
        let long = vec![b'x'; 4096];
        let mut data = long.clone();
        data.push(b'\n');
        let err = lines(&data, 1024).await.unwrap_err();
        assert!(matches!(err, Error::OversizedFrame { limit: 1024 }));
    }

    #[tokio::test]
    async fn rejects_oversized_frame_before_delimiter() {
        // No newline at all; cap must trip while buffering, not at EOF.
        let long = vec![b'x'; 4096];
        let err = lines(&long, 1024).await.unwrap_err();
        assert!(matches!(err, Error::OversizedFrame { .. }));
    }

    fn chunk(id: u64, index: u64, count: u64, data: &[u8]) -> String {
        use base64::Engine as _;
        format!(
            r#"{{"type":"rpc_chunk","chunkId":{id},"index":{index},"count":{count},"data":"{}"}}"#,
            base64::engine::general_purpose::STANDARD.encode(data)
        )
    }

    use base64::Engine as _;
    fn b64(data: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(data)
    }

    #[test]
    fn reassembles_in_order() {
        let mut r = ChunkReassembler::new(1 << 20);
        assert!(r.feed(1, 0, 2, &b64(b"hel")).unwrap().is_none());
        let frame = r.feed(1, 1, 2, &b64(b"lo")).unwrap().unwrap();
        assert_eq!(frame, b"hello".to_vec());
    }

    #[test]
    fn reassembles_out_of_order_with_duplicates() {
        let mut r = ChunkReassembler::new(1 << 20);
        assert!(r.feed(7, 2, 3, &b64(b"!")).unwrap().is_none());
        assert!(r.feed(7, 0, 3, &b64(b"he")).unwrap().is_none());
        assert!(r.feed(7, 0, 3, &b64(b"he")).unwrap().is_none()); // duplicate ignored
        let frame = r.feed(7, 1, 3, &b64(b"y")).unwrap().unwrap();
        assert_eq!(frame, b"hey!".to_vec());
    }

    #[test]
    fn rejects_bad_chunk_shapes() {
        let mut r = ChunkReassembler::new(1 << 20);
        assert!(r.feed(1, 0, 0, "x").is_err());
        assert!(r.feed(1, 5, 2, "x").is_err());
        assert!(r.feed(1, 0, 2, "!!!not base64!!!").is_err());
    }

    #[test]
    fn enforces_reassembled_cap() {
        let mut r = ChunkReassembler::new(8);
        assert!(r.feed(1, 0, 1, &b64(b"0123456789")).is_err());
        // Partial must be dropped after the failure; a fresh small chunk completes.
        let frame = r.feed(1, 0, 1, &b64(b"ok")).unwrap().unwrap();
        assert_eq!(frame, b"ok".to_vec());
    }
}
