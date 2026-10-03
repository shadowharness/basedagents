//! Per-isolate public-row fragments. SQL, filtering and authorization stay
//! outside Wasm. All exports are synchronous; no output view may outlive the
//! next call. The JS boundary copies the output before starting an HTTP send.
use std::{cell::RefCell, collections::HashMap};

struct Row { bytes: Vec<u8>, expires: Vec<u8>, expiry: Option<u128>, eligible: bool }
#[derive(Clone, Copy, PartialEq, Eq)]
struct Epoch { incarnation: u128, version: u128 }
struct KeyedPage {
    key: Vec<u8>, epoch: Epoch, rows: Vec<Row>, body: Vec<u8>, mask: Option<u128>,
    revision: u32, touched: u128, window: Option<(u128, u128)>,
}
#[derive(Default)]
struct Store {
    input: Vec<u8>, output: Vec<u8>, pages: HashMap<u32, Vec<Row>>,
    keyed: HashMap<u32, KeyedPage>, index: HashMap<u128, Vec<u32>>, tick: u128,
    hit: u32,
}
thread_local! { static STORE: RefCell<Store> = RefCell::new(Store::default()); }

#[no_mangle]
pub extern "C" fn input_resize(len: u32) -> *mut u8 {
    STORE.with(|s| { let mut s = s.borrow_mut(); s.input.resize(len as usize, 0); s.input.as_mut_ptr() })
}
fn read_u32(bytes: &[u8], offset: &mut usize) -> Option<u32> {
    let value = u32::from_le_bytes(bytes.get(*offset..*offset + 4)?.try_into().ok()?);
    *offset += 4; Some(value)
}
fn parse(bytes: &[u8]) -> Option<Vec<Row>> {
    let mut offset = 0;
    let count = read_u32(bytes, &mut offset)?;
    if count > 100 { return None; }
    let mut rows = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let len = read_u32(bytes, &mut offset)? as usize;
        let expiry_len = read_u32(bytes, &mut offset)? as usize;
        let eligible = read_u32(bytes, &mut offset)? != 0;
        let row = bytes.get(offset..offset.checked_add(len)?)?.to_vec(); offset += len;
        let expires = bytes.get(offset..offset.checked_add(expiry_len)?)?.to_vec(); offset += expiry_len;
        let expiry = timestamp(&expires);
        rows.push(Row { bytes: row, expires, expiry, eligible });
    }
    if offset != bytes.len() { return None; }
    Some(rows)
}
#[no_mangle]
pub extern "C" fn put(id: u32, len: u32) -> u32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(bytes) = s.input.get(..len as usize) else { return 0; };
        let Some(rows) = parse(bytes) else { return 0; };
        s.pages.insert(id, rows); 1
    })
}
#[no_mangle]
pub extern "C" fn remove(id: u32) { STORE.with(|s| {
    let mut s = s.borrow_mut(); s.pages.remove(&id);
    if let Some(page) = s.keyed.remove(&id) {
        let hash = fingerprint(&page.key);
        if let Some(ids) = s.index.get_mut(&hash) { ids.retain(|&i| i != id); }
        if s.index.get(&hash).is_some_and(|ids| ids.is_empty()) { s.index.remove(&hash); }
    }
}); }
#[no_mangle]
pub extern "C" fn render(id: u32, now_len: u32, reuse: u32) -> *const u8 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Store { input, output, pages, .. } = &mut *s;
        if reuse == 0 { *output = Vec::new(); } else { output.clear(); }
        output.extend_from_slice(b"{\"ok\":true,\"tasks\":[");
        if let Some(rows) = pages.get(&id) {
            let now = &input[..now_len as usize];
            for (index, row) in rows.iter().enumerate() {
                if index != 0 { output.push(b','); }
                output.extend_from_slice(&row.bytes);
                let claimable = row.eligible && (row.expires.is_empty() || row.expires.as_slice() > now);
                output.extend_from_slice(if claimable { b"true}" } else { b"false}" });
            }
        }
        output.extend_from_slice(b"]}"); output.as_ptr()
    })
}
#[no_mangle]
pub extern "C" fn output_len() -> u32 { STORE.with(|s| s.borrow().output.len() as u32) }

// The query fingerprint is only an index: exact key equality resolves collisions.
fn fingerprint(bytes: &[u8]) -> u128 {
    bytes.iter().fold(0x6c62272e07bb014262b821756295c58du128,
        |h, b| (h ^ *b as u128).wrapping_mul(0x0000000001000000000000000000013b))
}
fn epoch(bytes: &[u8]) -> Option<Epoch> {
    let text = std::str::from_utf8(bytes).ok()?;
    let (incarnation, version) = text.split_once(':')?;
    if incarnation.len() != 32 { return None; }
    Some(Epoch { incarnation: u128::from_str_radix(incarnation, 16).ok()?, version: version.parse().ok()? })
}
// Preserve lexicographic ISO semantics. Noncanonical legacy values use raw bytes.
fn timestamp(bytes: &[u8]) -> Option<u128> {
    if bytes.len() != 24 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T'
        || bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'.' || bytes[23] != b'Z' { return None; }
    let mut value = 0u128;
    for &i in &[0usize,1,2,3,5,6,8,9,11,12,14,15,17,18,20,21,22] {
        if !bytes[i].is_ascii_digit() { return None; }
        value = value * 10 + (bytes[i] - b'0') as u128;
    }
    Some(value)
}
fn claim_mask(rows: &[Row], now: &[u8]) -> u128 {
    let packed_now = timestamp(now);
    rows.iter().enumerate().fold(0u128, |mask, (i, row)| {
        let live = match (row.expiry, packed_now) {
            (Some(expiry), Some(now)) => expiry > now,
            _ => row.expires.is_empty() || row.expires.as_slice() > now,
        };
        mask | if row.eligible && live { 1u128 << i } else { 0 }
    })
}
fn refresh(page: &mut KeyedPage, now: &[u8]) {
    let packed = timestamp(now);
    if let (Some(now), Some((lower, upper))) = (packed, page.window) {
        if now >= lower && now < upper { return; }
    }
    let mask = claim_mask(&page.rows, now);
    page.window = packed.and_then(|now| {
        let (mut lower, mut upper) = (0u128, u128::MAX);
        for row in &page.rows {
            if !row.eligible || row.expires.is_empty() { continue; }
            let expiry = row.expiry?;
            if expiry <= now { lower = lower.max(expiry); } else { upper = upper.min(expiry); }
        }
        Some((lower, upper))
    });
    if page.mask == Some(mask) { return; }
    page.body.clear();
    let needed = 21 + page.rows.iter().map(|r| r.bytes.len() + 7).sum::<usize>();
    if page.body.capacity() < needed { page.body.reserve_exact(needed); }
    page.body.extend_from_slice(b"{\"ok\":true,\"tasks\":[");
    for (i, row) in page.rows.iter().enumerate() {
        if i != 0 { page.body.push(b','); }
        page.body.extend_from_slice(&row.bytes);
        page.body.extend_from_slice(if mask & (1u128 << i) != 0 { b"true}" } else { b"false}" });
    }
    page.body.extend_from_slice(b"]}"); page.mask = Some(mask);
    page.revision = page.revision.checked_add(1).expect("response revision exhausted");
}
#[no_mangle]
pub extern "C" fn put_keyed(id: u32, key_len: u32, epoch_len: u32, len: u32) -> u32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(bytes) = s.input.get(..len as usize) else { return 0; };
        let split = key_len as usize;
        let end = split + epoch_len as usize;
        let Some(key) = bytes.get(..split) else { return 0; };
        let Some(generation) = bytes.get(split..end).and_then(epoch) else { return 0; };
        let Some(rows) = bytes.get(end..).and_then(parse) else { return 0; };
        let key = key.to_vec(); let hash = fingerprint(&key);
        if s.keyed.contains_key(&id) { return 0; }
        s.tick += 1; let touched = s.tick;
        s.keyed.insert(id, KeyedPage { key, epoch: generation, rows, body: Vec::new(), mask: None, revision: 0, touched, window: None });
        s.index.entry(hash).or_default().push(id); 1
    })
}
#[no_mangle]
pub extern "C" fn lookup(key_len: u32, epoch_len: u32, now_len: u32) -> u32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut(); s.hit = 0; s.tick += 1;
        let Store { input, keyed, index, tick, hit, .. } = &mut *s;
        let split = key_len as usize; let end = split + epoch_len as usize;
        let Some(key) = input.get(..split) else { return 0; };
        let Some(generation) = input.get(split..end).and_then(epoch) else { return 0; };
        let Some(now) = input.get(end..end + now_len as usize) else { return 0; };
        let Some(ids) = index.get(&fingerprint(key)) else { return 0; };
        for &id in ids {
            let page = keyed.get_mut(&id).unwrap();
            if page.key == key && page.epoch == generation {
                page.touched = *tick; refresh(page, now); *hit = id; return id;
            }
        }
        0
    })
}
#[no_mangle]
pub extern "C" fn keyed_ptr() -> *const u8 { STORE.with(|s| { let s = s.borrow(); s.keyed[&s.hit].body.as_ptr() }) }
#[no_mangle]
pub extern "C" fn keyed_len() -> u32 { STORE.with(|s| { let s = s.borrow(); s.keyed[&s.hit].body.len() as u32 }) }
#[no_mangle]
pub extern "C" fn keyed_revision() -> u32 { STORE.with(|s| { let s = s.borrow(); s.keyed[&s.hit].revision }) }
#[no_mangle]
pub extern "C" fn oldest_id() -> u32 { STORE.with(|s| s.borrow().keyed.iter().min_by_key(|(_, p)| p.touched).map_or(0, |(&id, _)| id)) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_truncated_or_oversized_payloads() {
        assert!(parse(&[]).is_none());
        assert!(parse(&101u32.to_le_bytes()).is_none());
        assert!(parse(&[1,0,0,0]).is_none());
        assert!(parse(&[0,0,0,0,1]).is_none());
        assert_eq!(parse(&[0,0,0,0]).unwrap().len(), 0);
    }
    #[test]
    fn fixed_width_boundaries_and_legacy_ordering() {
        let earlier = b"2027-12-31T23:59:59.999Z";
        let later = b"2028-01-01T00:00:00.000Z";
        assert!(timestamp(earlier).unwrap() < timestamp(later).unwrap());
        assert!(timestamp(b"+010000-01-01T00:00:00.000Z").is_none());
        let rows: Vec<Row> = (0..100).map(|_| Row { bytes: vec![], expires: later.to_vec(), expiry: timestamp(later), eligible: true }).collect();
        assert_eq!(claim_mask(&rows, earlier), (1u128 << 100) - 1);
        assert_eq!(claim_mask(&rows, later), 0);
        let a = epoch(b"ffffffffffffffffffffffffffffffff:9007199254740992").unwrap();
        let b = epoch(b"ffffffffffffffffffffffffffffffff:9007199254740993").unwrap();
        assert!(a != b); assert_eq!(a.incarnation, u128::MAX);
    }
}
