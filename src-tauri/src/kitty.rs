// Kitty graphics protocol proxy.
//
// awrit (and other kitty-graphics apps) paint by emitting APC sequences
//   ESC _ G <control-keys> ; <base64 payload> ESC \
// where the payload is, depending on the transmission medium `t`:
//   t=d  direct   -> base64(pixel/PNG bytes)            (default)
//   t=s  shm      -> base64(POSIX shared-memory name)
//   t=t  tmpfile  -> base64(path), deleted after read
//   t=f  file     -> base64(path), kept
// The pixel data itself is never in the byte stream for shm/file media, so a
// JS terminal in a webview cannot resolve it. This native module does: it
// extracts the APC out of the raw pty stream, resolves the medium to RGBA8
// bytes, and hands a `Graphics` value up to pty.rs to forward to the webview.
//
// awrit specifics (see awrit/tui.cc Paint): it writes the WHOLE device-pixel
// framebuffer (RGBA, premultiplied alpha) to one reused shm `/awrit-<n>` each
// paint and sends `a=T,s=W,v=H,t=s,x=0,y=0,C=1`. So every frame is a full-frame
// blit at the origin; there is no dirty-rect tiling to reassemble.

use std::collections::HashMap;
use std::os::fd::RawFd;

use base64::{engine::general_purpose::STANDARD, Engine};

/// One resolved graphics command, ready to ship to the webview compositor.
#[derive(Clone)]
pub struct Graphics {
    pub action: char,    // 'T' transmit+display, 'd' delete, 'p' placement…
    pub id: u32,         // image id (i=)
    pub format: u16,     // 24 (RGB), 32 (RGBA), 100 (PNG) — always RGBA after resolve
    pub width: u32,      // s= pixel width
    pub height: u32,     // v= pixel height
    pub x: i32,          // x= pixel placement offset
    pub y: i32,          // y=
    pub no_scroll: bool, // C=1
    pub delete: bool,    // action == 'd'
    pub rgba: Vec<u8>,   // resolved straight RGBA8 (empty for delete/query)
}

pub enum ScanOut {
    /// Normal terminal bytes — write to xterm via `pty-data`.
    Passthrough(Vec<u8>),
    /// A resolved graphics frame — composite onto the overlay.
    Graphics(Graphics),
    /// Bytes to write back to the pty (query acknowledgements).
    Reply(Vec<u8>),
}

#[derive(PartialEq)]
enum State {
    Normal,
    Esc,    // saw ESC in the normal stream
    Apc,    // inside APC body (after ESC _)
    ApcEsc, // inside APC, saw ESC (expecting '\' = ST)
}

struct Pending {
    keys: HashMap<u8, String>,
    data: Vec<u8>,
}

pub struct KittyScanner {
    state: State,
    apc: Vec<u8>,
    pending: Option<Pending>,
}

impl Default for KittyScanner {
    fn default() -> Self {
        Self { state: State::Normal, apc: Vec::new(), pending: None }
    }
}

impl KittyScanner {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ScanOut> {
        let mut out = Vec::new();
        let mut pass: Vec<u8> = Vec::new();
        for &b in bytes {
            match self.state {
                State::Normal => {
                    if b == 0x1b {
                        self.state = State::Esc;
                    } else {
                        pass.push(b);
                    }
                }
                State::Esc => {
                    if b == b'_' {
                        self.state = State::Apc;
                        self.apc.clear();
                    } else {
                        // Not an APC — re-emit the swallowed ESC then reprocess b.
                        pass.push(0x1b);
                        if b == 0x1b {
                            self.state = State::Esc;
                        } else {
                            pass.push(b);
                            self.state = State::Normal;
                        }
                    }
                }
                State::Apc => {
                    if b == 0x1b {
                        self.state = State::ApcEsc;
                    } else {
                        self.apc.push(b);
                    }
                }
                State::ApcEsc => {
                    if b == b'\\' {
                        // ST: APC complete.
                        flush(&mut out, &mut pass);
                        if let Some(o) = self.finish_apc() {
                            out.push(o);
                        }
                        self.state = State::Normal;
                    } else {
                        // Stray ESC inside APC: treat as literal payload byte.
                        self.apc.push(0x1b);
                        if b == 0x1b {
                            self.state = State::ApcEsc;
                        } else {
                            self.apc.push(b);
                            self.state = State::Apc;
                        }
                    }
                }
            }
        }
        flush(&mut out, &mut pass);
        out
    }

    fn finish_apc(&mut self) -> Option<ScanOut> {
        let apc = std::mem::take(&mut self.apc);
        // Only kitty graphics APCs start with 'G'. Re-emit anything else verbatim.
        if apc.first() != Some(&b'G') {
            let mut v = vec![0x1b, b'_'];
            v.extend_from_slice(&apc);
            v.extend_from_slice(&[0x1b, b'\\']);
            return Some(ScanOut::Passthrough(v));
        }
        let body = &apc[1..];
        let (ctrl, payload_b64) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (body, &b""[..]),
        };
        let keys = parse_keys(ctrl);
        let payload = STANDARD.decode(payload_b64).unwrap_or_default();
        let more = keys.get(&b'm').map(|s| s == "1").unwrap_or(false);

        if let Some(p) = self.pending.as_mut() {
            // Continuation chunk: append decoded bytes, keep first-chunk keys.
            p.data.extend_from_slice(&payload);
            if more {
                return None;
            }
            let Pending { keys, data } = self.pending.take().unwrap();
            return resolve(keys, data);
        }
        if more {
            self.pending = Some(Pending { keys, data: payload });
            return None;
        }
        resolve(keys, payload)
    }
}

fn flush(out: &mut Vec<ScanOut>, pass: &mut Vec<u8>) {
    if !pass.is_empty() {
        out.push(ScanOut::Passthrough(std::mem::take(pass)));
    }
}

/// Parse "f=32,a=T,s=10,v=10,t=s" into {b'f':"32", b'a':"T", …}. Keys are
/// single ascii letters in this protocol, so index by the first byte.
fn parse_keys(ctrl: &[u8]) -> HashMap<u8, String> {
    let mut m = HashMap::new();
    let s = String::from_utf8_lossy(ctrl);
    for kv in s.split(',') {
        if let Some((k, v)) = kv.split_once('=') {
            if let Some(&key) = k.as_bytes().first() {
                m.insert(key, v.to_string());
            }
        }
    }
    m
}

fn geti(keys: &HashMap<u8, String>, k: u8, default: i64) -> i64 {
    keys.get(&k).and_then(|s| s.parse().ok()).unwrap_or(default)
}

fn resolve(keys: HashMap<u8, String>, payload: Vec<u8>) -> Option<ScanOut> {
    let action = keys.get(&b'a').and_then(|s| s.chars().next()).unwrap_or('t');
    let id = geti(&keys, b'i', 0) as u32;

    if action == 'q' {
        // Capability probe. Reply OK so the app turns graphics on.
        let mut v = vec![0x1b, b'_', b'G'];
        if id != 0 {
            v.extend_from_slice(format!("i={id}").as_bytes());
        }
        v.extend_from_slice(b";OK");
        v.extend_from_slice(&[0x1b, b'\\']);
        return Some(ScanOut::Reply(v));
    }

    let width = geti(&keys, b's', 0) as u32;
    let height = geti(&keys, b'v', 0) as u32;
    let x = geti(&keys, b'x', 0) as i32;
    let y = geti(&keys, b'y', 0) as i32;
    let no_scroll = geti(&keys, b'C', 0) == 1;
    let format = geti(&keys, b'f', 32) as u16;

    if action == 'd' {
        return Some(ScanOut::Graphics(Graphics {
            action, id, format, width, height, x, y, no_scroll,
            delete: true,
            rgba: Vec::new(),
        }));
    }

    // Resolve the transmission medium to raw bytes.
    let medium = keys.get(&b't').and_then(|s| s.chars().next()).unwrap_or('d');
    let raw = match medium {
        'd' => payload, // already base64-decoded pixel/PNG bytes
        's' => read_shm(&String::from_utf8_lossy(&payload))?,
        't' => read_path(&String::from_utf8_lossy(&payload), true)?,
        'f' => read_path(&String::from_utf8_lossy(&payload), false)?,
        _ => return None,
    };

    let rgba = to_rgba(raw, format, width, height)?;
    Some(ScanOut::Graphics(Graphics {
        action, id, format, width, height, x, y, no_scroll,
        delete: false,
        rgba,
    }))
}

/// Open a POSIX shared-memory object and copy its bytes out. We do NOT
/// shm_unlink: awrit reuses one fixed-name object across frames and recreates
/// it with O_CREAT, so leaving it in place is correct and leak-free for awrit.
fn read_shm(name: &str) -> Option<Vec<u8>> {
    let cname = std::ffi::CString::new(name).ok()?;
    unsafe {
        let fd: RawFd = libc::shm_open(cname.as_ptr(), libc::O_RDONLY);
        if fd < 0 {
            return None;
        }
        let mut st: libc::stat = std::mem::zeroed();
        if libc::fstat(fd, &mut st) < 0 || st.st_size <= 0 {
            libc::close(fd);
            return None;
        }
        let len = st.st_size as usize;
        let ptr = libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ, libc::MAP_SHARED, fd, 0);
        if ptr == libc::MAP_FAILED {
            libc::close(fd);
            return None;
        }
        let data = std::slice::from_raw_parts(ptr as *const u8, len).to_vec();
        libc::munmap(ptr, len);
        libc::close(fd);
        Some(data)
    }
}

fn read_path(path: &str, remove: bool) -> Option<Vec<u8>> {
    let data = std::fs::read(path).ok()?;
    if remove {
        let _ = std::fs::remove_file(path);
    }
    Some(data)
}

/// Normalize raw bytes to straight RGBA8 of size width*height*4.
fn to_rgba(data: Vec<u8>, format: u16, width: u32, height: u32) -> Option<Vec<u8>> {
    let px = (width as usize) * (height as usize);
    match format {
        32 => {
            let need = px * 4;
            let mut v = data;
            v.truncate(need);
            if v.len() < need {
                v.resize(need, 0);
            }
            Some(v)
        }
        24 => {
            let need = px * 3;
            if data.len() < need {
                return None;
            }
            let mut out = Vec::with_capacity(px * 4);
            for chunk in data[..need].chunks_exact(3) {
                out.extend_from_slice(chunk);
                out.push(255);
            }
            Some(out)
        }
        100 => decode_png(&data),
        _ => None,
    }
}

fn decode_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    match info.color_type {
        png::ColorType::Rgba => Some(buf),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(buf.len() / 3 * 4);
            for c in buf.chunks_exact(3) {
                out.extend_from_slice(c);
                out.push(255);
            }
            Some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graphics(outs: Vec<ScanOut>) -> Option<Graphics> {
        outs.into_iter().find_map(|o| match o {
            ScanOut::Graphics(g) => Some(g),
            _ => None,
        })
    }

    fn passthrough(outs: &[ScanOut]) -> Vec<u8> {
        outs.iter()
            .filter_map(|o| match o {
                ScanOut::Passthrough(b) => Some(b.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    #[test]
    fn plain_text_passes_through() {
        let mut s = KittyScanner::default();
        let out = s.feed(b"hello \x1b[0m world");
        assert_eq!(passthrough(&out), b"hello \x1b[0m world");
        assert!(graphics(out).is_none());
    }

    #[test]
    fn direct_rgba_2x1() {
        // 2x1 RGBA: red, green
        let pixels = [255u8, 0, 0, 255, 0, 255, 0, 255];
        let b64 = STANDARD.encode(pixels);
        let seq = format!("\x1b_Gf=32,a=T,s=2,v=1,t=d;{b64}\x1b\\");
        let mut s = KittyScanner::default();
        let g = graphics(s.feed(seq.as_bytes())).expect("graphics");
        assert_eq!((g.width, g.height), (2, 1));
        assert_eq!(g.rgba, pixels);
        assert!(g.no_scroll == false);
    }

    #[test]
    fn surrounding_text_preserved_and_ordered() {
        let pixels = [1u8, 2, 3, 4];
        let b64 = STANDARD.encode(pixels);
        let seq = format!("A\x1b_Gf=32,a=T,s=1,v=1,t=d;{b64}\x1b\\B");
        let mut s = KittyScanner::default();
        let out = s.feed(seq.as_bytes());
        assert_eq!(passthrough(&out), b"AB");
        assert_eq!(graphics(out).unwrap().rgba, pixels);
    }

    #[test]
    fn split_across_feeds() {
        let pixels = [9u8, 8, 7, 6];
        let b64 = STANDARD.encode(pixels);
        let seq = format!("\x1b_Gf=32,a=T,s=1,v=1,t=d;{b64}\x1b\\");
        let bytes = seq.as_bytes();
        let mut s = KittyScanner::default();
        let mid = bytes.len() / 2;
        let mut out = s.feed(&bytes[..mid]);
        out.extend(s.feed(&bytes[mid..]));
        assert_eq!(graphics(out).unwrap().rgba, pixels);
    }

    #[test]
    fn chunked_direct() {
        let pixels = [10u8, 20, 30, 40, 50, 60, 70, 80];
        let (a, b) = pixels.split_at(4);
        let seq = format!(
            "\x1b_Gf=32,a=T,s=2,v=1,t=d,m=1;{}\x1b\\\x1b_Gm=0;{}\x1b\\",
            STANDARD.encode(a),
            STANDARD.encode(b),
        );
        let mut s = KittyScanner::default();
        let g = graphics(s.feed(seq.as_bytes())).expect("graphics");
        assert_eq!(g.rgba, pixels);
    }

    #[test]
    fn query_gets_ok_reply() {
        let mut s = KittyScanner::default();
        let out = s.feed(b"\x1b_Gi=31,a=q,s=1,v=1,t=d;AAAA\x1b\\");
        let reply = out.iter().find_map(|o| match o {
            ScanOut::Reply(b) => Some(b.clone()),
            _ => None,
        });
        assert_eq!(reply.unwrap(), b"\x1b_Gi=31;OK\x1b\\");
    }

    #[test]
    fn shm_medium_resolves_pixels() {
        // Mirror awrit: create a POSIX shm object, write RGBA, then transmit it
        // by name with t=s and assert the proxy reads the pixels back out.
        let name = "/instant-kitty-test";
        let pixels: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8]; // 2x1 RGBA
        let cname = std::ffi::CString::new(name).unwrap();
        unsafe {
            libc::shm_unlink(cname.as_ptr()); // clean any leftover
            let fd = libc::shm_open(cname.as_ptr(), libc::O_RDWR | libc::O_CREAT, 0o600);
            assert!(fd >= 0, "shm_open failed");
            assert_eq!(libc::ftruncate(fd, pixels.len() as libc::off_t), 0);
            let ptr = libc::mmap(
                std::ptr::null_mut(),
                pixels.len(),
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            );
            assert_ne!(ptr, libc::MAP_FAILED);
            std::ptr::copy_nonoverlapping(pixels.as_ptr(), ptr as *mut u8, pixels.len());
            libc::munmap(ptr, pixels.len());
            libc::close(fd);
        }

        let seq = format!(
            "\x1b_Gf=32,a=T,s=2,v=1,t=s,x=0,y=0,C=1;{}\x1b\\",
            STANDARD.encode(name),
        );
        let mut s = KittyScanner::default();
        let g = graphics(s.feed(seq.as_bytes())).expect("graphics");
        unsafe {
            libc::shm_unlink(cname.as_ptr());
        }
        assert_eq!((g.width, g.height), (2, 1));
        assert!(g.no_scroll);
        assert_eq!(g.rgba, pixels);
    }

    #[test]
    fn rgb_expands_to_rgba() {
        let rgb = [11u8, 22, 33, 44, 55, 66];
        let b64 = STANDARD.encode(rgb);
        let seq = format!("\x1b_Gf=24,a=T,s=2,v=1,t=d;{b64}\x1b\\");
        let mut s = KittyScanner::default();
        let g = graphics(s.feed(seq.as_bytes())).unwrap();
        assert_eq!(g.rgba, [11, 22, 33, 255, 44, 55, 66, 255]);
    }
}
