//! Wall-clock time as the app stores it: milliseconds since the Unix epoch.

use std::time::{SystemTime, UNIX_EPOCH};

/// Now, in epoch milliseconds (0 if the clock is before 1970).
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
