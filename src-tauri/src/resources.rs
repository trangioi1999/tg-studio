//! Process ownership and resource samples. Sampling never holds the ownership lock.
use std::{collections::{HashMap, HashSet}, sync::{LazyLock, Mutex}};
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Clone, Debug, PartialEq)]
pub enum Owner { Run(String), Warm }

static REGISTRY: LazyLock<Mutex<HashMap<u32, Owner>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SYSTEM: Mutex<Option<System>> = Mutex::new(None);

pub fn register(pid: u32, owner: Owner) {
    match REGISTRY.lock() {
        Ok(mut registry) => { registry.insert(pid, owner); }
        Err(e) => eprintln!("Không ghi được sổ tiến trình: {e}"),
    }
}

pub fn unregister(pid: u32) {
    match REGISTRY.lock() {
        Ok(mut registry) => { registry.remove(&pid); }
        Err(e) => eprintln!("Không xoá được sổ tiến trình: {e}"),
    }
}

/// Follows the headless child into its waiter, including early setup failures.
pub struct Registration(Option<u32>);
impl Registration {
    pub fn new(pid: Option<u32>, owner: Owner) -> Self {
        if let Some(pid) = pid { register(pid, owner); }
        Self(pid)
    }
}
impl Drop for Registration {
    fn drop(&mut self) { if let Some(pid) = self.0 { unregister(pid); } }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcStat {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    /// Percent of one logical core.
    pub cpu: f32,
    /// Resident bytes.
    pub memory: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageGroup {
    pub kind: String,
    pub run_id: Option<String>,
    pub cpu: f32,
    pub memory: u64,
    pub processes: Vec<ProcStat>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReport {
    pub at: u64,
    pub cpu: f32,
    pub memory: u64,
    pub cores: usize,
    pub groups: Vec<UsageGroup>,
    pub webview: bool,
}

fn is_webview(name: &str) -> bool {
    // Linux comm names can be truncated to 15 bytes.
    name.eq_ignore_ascii_case("msedgewebview2.exe") || matches!(name,
        "WebKitWebProcess" | "WebKitNetworkProcess" | "WebKitWebProces" | "WebKitNetworkPr")
}

fn group(kind: &str, run_id: Option<String>) -> UsageGroup {
    UsageGroup { kind: kind.into(), run_id, cpu: 0.0, memory: 0, processes: vec![] }
}

/// Pure grouping, with stable PID order and parents before children. A nested
/// registered root owns its subtree; no process is counted twice.
fn group_processes(processes: &[ProcStat], registry: &HashMap<u32, Owner>, app: u32) -> (Vec<UsageGroup>, bool) {
    let by_pid: HashMap<_, _> = processes.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in processes { if let Some(parent) = p.parent { children.entry(parent).or_default().push(p.pid); } }
    for list in children.values_mut() { list.sort_unstable(); }
    let mut roots: Vec<_> = registry.keys().copied().filter(|pid| *pid != app && by_pid.contains_key(pid)).collect();
    roots.sort_unstable();
    let mut groups = vec![group("app", None)];
    let mut owners = HashMap::new();
    for pid in &roots {
        owners.insert(*pid, groups.len());
        groups.push(match &registry[pid] { Owner::Run(id) => group("run", Some(id.clone())), Owner::Warm => group("warm", None) });
    }
    let other = groups.len();
    groups.push(group("other", None));
    let mut visited = HashSet::new();
    let mut webview = false;
    // Include registered roots that have been reparented, as well as app descendants.
    for root in std::iter::once(app).chain(roots) {
        let mut pending = vec![(root, other)];
        while let Some((pid, inherited)) = pending.pop() {
            let Some(p) = by_pid.get(&pid) else { continue };
            if !visited.insert(pid) { continue; }
            let owner = if pid == app { 0 } else if let Some(owner) = owners.get(&pid) { *owner }
                else if inherited != other && inherited != 0 { inherited }
                else if is_webview(&p.name) || inherited == 0 && pid != root { webview = true; 0 }
                else { other };
            let g = &mut groups[owner];
            g.cpu += p.cpu;
            g.memory = g.memory.saturating_add(p.memory);
            g.processes.push((*p).clone());
            if let Some(list) = children.get(&pid) {
                // The app itself does not make all its children WebViews.
                let next = if pid == app { other } else { owner };
                pending.extend(list.iter().rev().map(|child| (*child, next)));
            }
        }
    }
    groups.retain(|g| !g.processes.is_empty());
    (groups, webview)
}

fn registry_snapshot() -> Result<HashMap<u32, Owner>, String> {
    REGISTRY.lock().map(|r| r.clone()).map_err(|e| format!("Không đọc được sổ tiến trình: {e}"))
}

fn sample() -> Result<Vec<ProcStat>, String> {
    let mut slot = SYSTEM.lock().map_err(|e| format!("Không đo được tài nguyên: {e}"))?;
    let first = slot.is_none();
    if first { *slot = Some(System::new().map_err(|e| format!("Không đo được tài nguyên: {e}"))?); }
    let system = slot.as_mut().expect("đã khởi tạo bộ đo");
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().without_tasks().with_cpu().with_memory());
    Ok(system.processes().iter().map(|(pid, p)| ProcStat {
        pid: pid.as_u32(), parent: p.parent().map(|p| p.as_u32()), name: p.name().to_string_lossy().into_owned(),
        cpu: if first { 0.0 } else { p.cpu_usage() }, memory: p.memory(),
    }).collect())
}

#[tauri::command]
pub async fn resource_usage() -> Result<ResourceReport, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        let processes = sample()?;
        let (groups, webview) = group_processes(&processes, &registry_snapshot()?, std::process::id());
        Ok(ResourceReport {
            at: crate::clock::now_ms(),
            cpu: groups.iter().map(|g| g.cpu).sum(), memory: groups.iter().map(|g| g.memory).sum(),
            cores: std::thread::available_parallelism().map(usize::from).unwrap_or(1), groups,
            webview: webview && !cfg!(target_os = "macos"),
        })
    }).await.map_err(|e| format!("Không đo được tài nguyên: {e}"))?;
    if let Err(e) = &result { eprintln!("{e}"); }
    result
}

fn validate_kill(pid: u32, processes: &[ProcStat], registry: &HashMap<u32, Owner>, app: u32) -> Result<(), String> {
    let parents: HashMap<_, _> = processes.iter().map(|p| (p.pid, p.parent)).collect();
    let descendant = |child: u32, ancestor: u32| {
        let mut current = Some(child);
        let mut seen = HashSet::new();
        while let Some(p) = current {
            if !seen.insert(p) { break; }
            if p == ancestor { return true; }
            current = parents.get(&p).copied().flatten();
        }
        false
    };
    if pid == app || !parents.contains_key(&pid) || !descendant(pid, app) {
        return Err("Chỉ được dừng tiến trình con của ứng dụng trong nhóm Khác.".into());
    }
    let (groups, _) = group_processes(processes, registry, app);
    let protected: Vec<_> = groups.iter().filter(|g| g.kind != "other").flat_map(|g| g.processes.iter()).collect();
    if protected.iter().any(|p| p.pid == pid || descendant(p.pid, pid)) {
        return Err("Không được dừng tiến trình của ứng dụng, WebView hoặc phiên agent đang mở.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn kill_process(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let processes = sample()?;
        validate_kill(pid, &processes, &registry_snapshot()?, std::process::id())
    }).await.map_err(|e| format!("Không kiểm tra được tiến trình: {e}"))??;
    crate::env::kill_tree(pid).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(pid: u32, parent: u32, name: &str) -> ProcStat {
        ProcStat { pid, parent: Some(parent), name: name.into(), cpu: 1.0, memory: 10 }
    }
    fn fixture() -> (Vec<ProcStat>, HashMap<u32, Owner>) {
        (vec![p(1, 0, "app"), p(2, 1, "run"), p(3, 2, "mcp"), p(4, 1, "warm"), p(5, 4, "mcp"), p(6, 1, "probe"), p(7, 6, "probe-child"), p(8, 1, "msedgewebview2.exe"), p(9, 8, "renderer"), p(10, 0, "unrelated")],
         HashMap::from([(2, Owner::Run("r".into())), (4, Owner::Warm), (99, Owner::Run("dead".into()))]))
    }
    #[test]
    fn groups_trees_once_and_ignores_dead_roots() {
        let (processes, registry) = fixture();
        let (groups, webview) = group_processes(&processes, &registry, 1);
        assert!(webview);
        assert_eq!(groups.iter().map(|g| (g.kind.as_str(), g.processes.iter().map(|p| p.pid).collect::<Vec<_>>())).collect::<Vec<_>>(),
            vec![("app", vec![1,8,9]), ("run", vec![2,3]), ("warm", vec![4,5]), ("other", vec![6,7])]);
        assert_eq!(groups[1].run_id.as_deref(), Some("r"));
        assert_eq!(groups.iter().map(|g| g.memory).sum::<u64>(), 90);
        assert_eq!(groups.iter().map(|g| g.cpu).sum::<f32>(), 9.0);
    }
    #[test]
    fn kill_only_allows_other_without_protected_descendants() {
        let (mut processes, registry) = fixture();
        for pid in [0,1,2,3,4,5,8,9,10,99] { assert!(validate_kill(pid, &processes, &registry, 1).is_err(), "{pid}"); }
        for pid in [6,7] { assert!(validate_kill(pid, &processes, &registry, 1).is_ok()); }
        processes.iter_mut().find(|p| p.pid == 4).unwrap().parent = Some(7);
        assert!(validate_kill(6, &processes, &registry, 1).is_err());
        assert!(validate_kill(7, &processes, &registry, 1).is_err());
    }
    #[test]
    fn reparented_and_nested_roots_are_not_double_counted() {
        let processes = vec![p(1,0,"app"), p(2,0,"run"), p(3,2,"nested"), p(4,3,"child")];
        let registry = HashMap::from([(2,Owner::Run("a".into())), (3,Owner::Run("b".into()))]);
        let (groups, webview) = group_processes(&processes, &registry, 1);
        assert!(!webview);
        assert_eq!(groups.iter().map(|g| g.processes.len()).collect::<Vec<_>>(), vec![1,1,2]);
        assert_eq!(groups[2].processes.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![3,4]);
    }
    #[test]
    fn registration_transfers_warm_to_run_and_guard_cleans_up() {
        let pid = u32::MAX;
        register(pid, Owner::Warm);
        assert_eq!(registry_snapshot().unwrap().get(&pid), Some(&Owner::Warm));
        {
            let _registration = Registration::new(Some(pid), Owner::Run("claimed".into()));
            assert_eq!(registry_snapshot().unwrap().get(&pid), Some(&Owner::Run("claimed".into())));
        }
        assert!(!registry_snapshot().unwrap().contains_key(&pid));
    }
    #[test]
    fn linux_webviews_are_app_owned_but_agent_webviews_stay_with_agent() {
        let processes = vec![p(1,0,"app"), p(2,1,"WebKitWebProcess"), p(3,1,"run"), p(4,3,"WebKitNetworkProcess")];
        let (groups, webview) = group_processes(&processes, &HashMap::from([(3,Owner::Run("r".into()))]), 1);
        assert!(webview);
        assert_eq!(groups[0].processes.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![1,2]);
        assert_eq!(groups[1].processes.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![3,4]);
    }
    #[test]
    fn truncated_linux_webviews_are_protected() {
        let processes = vec![p(1,0,"app"), p(2,1,"WebKitWebProces"), p(3,1,"WebKitNetworkPr")];
        let registry = HashMap::new();
        let (groups, webview) = group_processes(&processes, &registry, 1);
        assert!(webview);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].processes.len(), 3);
        for pid in [2,3] { assert!(validate_kill(pid, &processes, &registry, 1).is_err()); }
    }
    #[test]
    fn report_serializes_the_shared_camel_case_contract() {
        let report = ResourceReport { at: 1, cpu: 2.0, memory: 30, cores: 4,
            groups: vec![group("run", Some("r".into()))], webview: false };
        let value = serde_json::to_value(report).unwrap();
        assert_eq!(value["groups"][0]["runId"], "r");
        assert!(value["groups"][0].get("run_id").is_none());
        assert_eq!(value["cores"], 4);
        assert_eq!(value["webview"], false);
    }
    #[test]
    fn macos_xpc_services_are_not_guessed_from_names() {
        let (groups, webview) = group_processes(&[p(1,0,"app"),p(2,0,"com.apple.WebKit.WebContent")], &HashMap::new(), 1);
        assert!(!webview);
        assert_eq!(groups[0].memory, 10);
    }
}
