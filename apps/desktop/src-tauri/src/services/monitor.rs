use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use sysinfo::{Disks, Networks, System};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, RwLock};

use crate::models::{
    DiskPartitionUsage, HostMetricsSnapshot, MonitorErrorEvent, NetInterfaceRate,
    IPC_EVENT_MONITOR_ERROR, IPC_EVENT_MONITOR_SAMPLE,
};
use crate::services::local_pty::LocalPtyService;
use crate::services::ssh::SshService;
use crate::services::vault::now_ms;

const PROBE_COMMAND: &str = concat!(
    "printf \"===CPU===\\n\"; ",
    "head -n 1 /proc/stat 2>/dev/null; ",
    "nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1; ",
    "printf \"===MEM===\\n\"; ",
    "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null; ",
    "printf \"===LOAD===\\n\"; ",
    "cat /proc/loadavg 2>/dev/null; ",
    "cat /proc/uptime 2>/dev/null; ",
    "printf \"===NET===\\n\"; ",
    "cat /proc/net/dev 2>/dev/null; ",
    "printf \"===DISK===\\n\"; ",
    "df -P -k 2>/dev/null; ",
    "printf \"===SYS===\\n\"; ",
    "hostname 2>/dev/null; ",
    "uname -r 2>/dev/null; ",
    "grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null"
);

const IGNORED_FS: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "squashfs",
    "udev",
    "none",
    "efivarfs",
    "cgroup",
    "cgroup2",
    "proc",
    "sysfs",
    "nsfs",
    "mqueue",
    "hugetlbfs",
    "debugfs",
    "tracefs",
    "securityfs",
    "pstore",
    "configfs",
    "fusectl",
    "binfmt_misc",
    "ramfs",
    "devpts",
    "autofs",
    "bpf",
];

#[derive(Clone, Copy)]
struct CpuRaw {
    total: u64,
    idle: u64,
}

fn split_sections(raw: &str) -> HashMap<String, String> {
    let mut sections = HashMap::new();
    let mut current_name: Option<String> = None;
    let mut current_lines: Vec<&str> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("===") && trimmed.ends_with("===") && trimmed.len() > 6 {
            if let Some(name) = current_name.take() {
                sections.insert(name, current_lines.join("\n").trim().to_string());
                current_lines.clear();
            }
            current_name = Some(trimmed[3..trimmed.len() - 3].to_string());
        } else if current_name.is_some() {
            current_lines.push(line);
        }
    }
    if let Some(name) = current_name {
        sections.insert(name, current_lines.join("\n").trim().to_string());
    }
    sections
}

fn parse_cpu_section(text: &str) -> (Option<CpuRaw>, usize) {
    let mut raw = None;
    let mut cores = 1usize;

    for line in text.lines().map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(rest) = line.strip_prefix("cpu ") {
            let nums: Vec<u64> = rest
                .split_whitespace()
                .map(|s| s.parse::<u64>().unwrap_or(0))
                .collect();
            let user = nums.first().copied().unwrap_or(0);
            let nice = nums.get(1).copied().unwrap_or(0);
            let sys = nums.get(2).copied().unwrap_or(0);
            let idle = nums.get(3).copied().unwrap_or(0);
            let iowait = nums.get(4).copied().unwrap_or(0);
            let irq = nums.get(5).copied().unwrap_or(0);
            let softirq = nums.get(6).copied().unwrap_or(0);
            let steal = nums.get(7).copied().unwrap_or(0);
            raw = Some(CpuRaw {
                total: user + nice + sys + idle + iowait + irq + softirq + steal,
                idle: idle + iowait,
            });
        } else if let Ok(c) = line.parse::<usize>() {
            cores = c.max(1);
        }
    }
    (raw, cores)
}

struct ParsedMem {
    mem_total_bytes: u64,
    mem_used_bytes: u64,
    mem_available_bytes: u64,
    mem_usage_percent: f64,
    swap_total_bytes: u64,
    swap_used_bytes: u64,
    swap_usage_percent: f64,
}

fn parse_mem_section(text: &str) -> ParsedMem {
    let mut values: HashMap<&str, u64> = HashMap::new();
    for line in text.lines() {
        if let Some((k, rest)) = line.split_once(':') {
            if let Some(num_str) = rest.split_whitespace().next() {
                if let Ok(kb) = num_str.parse::<u64>() {
                    values.insert(k.trim(), kb.saturating_mul(1024));
                }
            }
        }
    }

    let mem_total_bytes = values.get("MemTotal").copied().unwrap_or(0);
    let mem_available_bytes = values.get("MemAvailable").copied().unwrap_or_else(|| {
        values.get("MemFree").copied().unwrap_or(0)
            + values.get("Buffers").copied().unwrap_or(0)
            + values.get("Cached").copied().unwrap_or(0)
    });
    let mem_used_bytes = mem_total_bytes.saturating_sub(mem_available_bytes);
    let mem_usage_percent = if mem_total_bytes > 0 {
        ((mem_used_bytes as f64 / mem_total_bytes as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    let swap_total_bytes = values.get("SwapTotal").copied().unwrap_or(0);
    let swap_free_bytes = values.get("SwapFree").copied().unwrap_or(0);
    let swap_used_bytes = swap_total_bytes.saturating_sub(swap_free_bytes);
    let swap_usage_percent = if swap_total_bytes > 0 {
        ((swap_used_bytes as f64 / swap_total_bytes as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    ParsedMem {
        mem_total_bytes,
        mem_used_bytes,
        mem_available_bytes,
        mem_usage_percent,
        swap_total_bytes,
        swap_used_bytes,
        swap_usage_percent,
    }
}

fn parse_load_section(text: &str) -> ([f64; 3], u64) {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
    let mut load = [0.0, 0.0, 0.0];
    let mut uptime = 0u64;

    if let Some(first) = lines.first() {
        let parts: Vec<&str> = first.split_whitespace().collect();
        load[0] = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        load[1] = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        load[2] = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    }
    if let Some(second) = lines.get(1) {
        if let Some(up_str) = second.split_whitespace().next() {
            uptime = up_str.parse::<f64>().unwrap_or(0.0).floor() as u64;
        }
    }
    (load, uptime)
}

fn parse_net_section(text: &str) -> HashMap<String, (u64, u64)> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let Some((iface_raw, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = iface_raw.trim();
        if iface.is_empty() || iface == "lo" {
            continue;
        }
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        let rx = fields[0].parse::<u64>().unwrap_or(0);
        let tx = fields[8].parse::<u64>().unwrap_or(0);
        map.insert(iface.to_string(), (rx, tx));
    }
    map
}

fn parse_disk_section(text: &str) -> Vec<DiskPartitionUsage> {
    let mut seen_mounts = HashSet::new();
    let mut disks = Vec::new();

    for line in text.lines().skip(1).map(str::trim).filter(|s| !s.is_empty()) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 6 {
            continue;
        }
        let filesystem = parts[0];
        let Ok(total_kb) = parts[1].parse::<u64>() else {
            continue;
        };
        if total_kb == 0 {
            continue;
        }
        let used_kb = parts[2].parse::<u64>().unwrap_or(0);
        let avail_kb = parts[3].parse::<u64>().unwrap_or(0);
        let mount = parts[5..].join(" ");

        if seen_mounts.contains(&mount) {
            continue;
        }

        let fs_lower = filesystem.to_lowercase();
        if mount != "/" {
            if IGNORED_FS.contains(&fs_lower.as_str()) {
                continue;
            }
            if mount.starts_with("/snap/")
                || mount.starts_with("/sys")
                || mount.starts_with("/proc")
                || mount.starts_with("/dev")
                || mount.starts_with("/run")
            {
                continue;
            }
            if fs_lower == "overlay" || fs_lower.starts_with("shm") {
                continue;
            }
        }

        seen_mounts.insert(mount.clone());
        let total_bytes = total_kb.saturating_mul(1024);
        let used_bytes = used_kb.saturating_mul(1024);
        let available_bytes = avail_kb.saturating_mul(1024);
        let used_percent = if total_bytes > 0 {
            ((used_bytes as f64 / total_bytes as f64) * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };

        disks.push(DiskPartitionUsage {
            filesystem: filesystem.to_string(),
            mount,
            total_bytes,
            used_bytes,
            available_bytes,
            used_percent,
        });
    }

    disks.sort_by(|a, b| {
        if a.mount == "/" {
            std::cmp::Ordering::Less
        } else if b.mount == "/" {
            std::cmp::Ordering::Greater
        } else {
            b.total_bytes.cmp(&a.total_bytes)
        }
    });
    disks
}

fn parse_sys_section(text: &str) -> (String, String, String) {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
    let hostname = lines.first().copied().unwrap_or("linux-host").to_string();
    let kernel = lines.get(1).copied().unwrap_or("").to_string();
    let mut os_pretty = "Linux".to_string();
    for line in lines.iter().skip(2) {
        if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
            os_pretty = val.trim_matches('"').to_string();
            break;
        }
    }
    (hostname, kernel, os_pretty)
}

struct MonitorHandle {
    stopped: Arc<AtomicBool>,
    interval_ms: Arc<AtomicU64>,
    wake_notify: Arc<Notify>,
}

#[derive(Clone)]
pub struct MonitorService {
    monitors: Arc<RwLock<HashMap<String, MonitorHandle>>>,
}

impl MonitorService {
    pub fn new() -> Self {
        Self {
            monitors: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn start(
        &self,
        app: &AppHandle,
        ssh: &SshService,
        local_pty: &LocalPtyService,
        session_id: String,
        interval_ms: u64,
    ) -> Result<(), String> {
        let safe_interval = interval_ms.clamp(1500, 15000);

        {
            let guard = self.monitors.read().await;
            if let Some(existing) = guard.get(&session_id) {
                if !existing.stopped.load(Ordering::Relaxed) {
                    existing.interval_ms.store(safe_interval, Ordering::Relaxed);
                    existing.wake_notify.notify_one();
                    return Ok(());
                }
            }
        }

        let is_local = local_pty.has_session(&session_id).await;
        if !is_local && !ssh.has_session(&session_id).await {
            return Err("当前终端会话未连接，无法启动实时监控".to_string());
        }

        let stopped = Arc::new(AtomicBool::new(false));
        let interval_atom = Arc::new(AtomicU64::new(safe_interval));
        let wake_notify = Arc::new(Notify::new());

        let handle = MonitorHandle {
            stopped: stopped.clone(),
            interval_ms: interval_atom.clone(),
            wake_notify: wake_notify.clone(),
        };
        self.monitors
            .write()
            .await
            .insert(session_id.clone(), handle);

        let closed_notify = if is_local {
            local_pty.closed_notifier(&session_id).await
        } else {
            ssh.closed_notifier(&session_id).await
        };

        let monitors_map = self.monitors.clone();
        let app_clone = app.clone();
        let ssh_clone = ssh.clone();
        let local_clone = local_pty.clone();

        tauri::async_runtime::spawn(async move {
            let mut sample_count = 0u64;
            let mut prev_cpu: Option<CpuRaw> = None;
            let mut prev_net: Option<(i64, HashMap<String, (u64, u64)>)> = None;

            // Local sysinfo state reused across ticks for accurate CPU & Network deltas
            let local_state = if is_local {
                Some(Arc::new(StdMutex::new((
                    System::new_all().ok(),
                    Disks::new_with_refreshed_list().ok(),
                    Networks::new_with_refreshed_list().ok(),
                    now_ms(),
                ))))
            } else {
                None
            };

            loop {
                if stopped.load(Ordering::Relaxed) {
                    break;
                }

                let next_delay_ms = if is_local {
                    if !local_clone.has_session(&session_id).await {
                        break;
                    }
                    let state_arc = local_state.as_ref().unwrap().clone();
                    let sid_snap = session_id.clone();
                    if let Ok(snapshot) = tokio::task::spawn_blocking(move || {
                        let mut guard = state_arc.lock().unwrap();
                        let (sys_opt, disks_opt, nets_opt, last_ts) = &mut *guard;
                        let now = now_ms();
                        let delta_sec = ((now - *last_ts) as f64 / 1000.0).max(0.1);
                        *last_ts = now;

                        let (
                            cpu_usage,
                            cpu_cores,
                            mem_total,
                            mem_used,
                            mem_avail,
                            mem_pct,
                            swap_total,
                            swap_used,
                            swap_pct,
                        ) = if let Some(sys) = sys_opt.as_mut() {
                            sys.refresh_cpu_usage();
                            sys.refresh_memory();

                            let cpu_u = sys.global_cpu_usage() as f64;
                            let cores = sys.cpus().len().max(1);

                            let mt = sys.total_memory();
                            let mu = sys.used_memory();
                            let ma = sys.available_memory();
                            let mp = if mt > 0 {
                                ((mu as f64 / mt as f64) * 100.0).clamp(0.0, 100.0)
                            } else {
                                0.0
                            };

                            let st = sys.total_swap();
                            let su = sys.used_swap();
                            let sp = if st > 0 {
                                ((su as f64 / st as f64) * 100.0).clamp(0.0, 100.0)
                            } else {
                                0.0
                            };
                            (cpu_u, cores, mt, mu, ma, mp, st, su, sp)
                        } else {
                            (0.0, 1, 0, 0, 0, 0.0, 0, 0, 0.0)
                        };

                        let mut disks_vec = Vec::new();
                        if let Some(disks) = disks_opt.as_mut() {
                            disks.refresh(true);
                            let mut seen = HashSet::new();
                            for d in disks.iter() {
                                let mount = d.mount_point().to_string_lossy().to_string();
                                let total = d.total_space();
                                if total == 0 || !seen.insert(mount.clone()) {
                                    continue;
                                }
                                let avail = d.available_space();
                                let used = total.saturating_sub(avail);
                                disks_vec.push(DiskPartitionUsage {
                                    filesystem: d.file_system().to_string_lossy().to_string(),
                                    mount,
                                    total_bytes: total,
                                    used_bytes: used,
                                    available_bytes: avail,
                                    used_percent: ((used as f64 / total as f64) * 100.0)
                                        .clamp(0.0, 100.0),
                                });
                            }
                        }

                        let mut net_rx_rate = 0.0;
                        let mut net_tx_rate = 0.0;
                        let mut net_ifaces = Vec::new();
                        if let Some(nets) = nets_opt.as_mut() {
                            nets.refresh(true);
                            for (iface_os, data) in nets.iter() {
                                let iface_name = iface_os.to_string_lossy().to_string();
                                if iface_name == "lo"
                                    || iface_name.to_lowercase().contains("loopback")
                                {
                                    continue;
                                }
                                let rx = data.received() as f64 / delta_sec;
                                let tx = data.transmitted() as f64 / delta_sec;
                                net_rx_rate += rx;
                                net_tx_rate += tx;
                                net_ifaces.push(NetInterfaceRate {
                                    name: iface_name,
                                    rx_bytes_per_sec: rx,
                                    tx_bytes_per_sec: tx,
                                });
                            }
                            net_ifaces.sort_by(|a, b| {
                                (b.rx_bytes_per_sec + b.tx_bytes_per_sec)
                                    .partial_cmp(&(a.rx_bytes_per_sec + a.tx_bytes_per_sec))
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            });
                            net_ifaces.truncate(4);
                        }

                        let load = System::load_average()
                            .map(|l| [l.one, l.five, l.fifteen])
                            .unwrap_or([0.0, 0.0, 0.0]);

                        HostMetricsSnapshot {
                            session_id: sid_snap,
                            timestamp: now,
                            hostname: System::host_name()
                                .unwrap_or_else(|_| "localhost".to_string()),
                            os_pretty_name: System::long_os_version()
                                .unwrap_or_else(|_| std::env::consts::OS.to_string()),
                            kernel: System::kernel_version()
                                .unwrap_or_else(|_| std::env::consts::ARCH.to_string()),
                            uptime_seconds: System::uptime().unwrap_or(0),
                            cpu_cores,
                            cpu_usage_percent: cpu_usage.clamp(0.0, 100.0),
                            load_average: load,
                            mem_total_bytes: mem_total,
                            mem_used_bytes: mem_used,
                            mem_available_bytes: mem_avail,
                            mem_usage_percent: mem_pct,
                            swap_total_bytes: swap_total,
                            swap_used_bytes: swap_used,
                            swap_usage_percent: swap_pct,
                            disks: disks_vec,
                            net_rx_bytes_per_sec: net_rx_rate,
                            net_tx_bytes_per_sec: net_tx_rate,
                            net_interfaces: net_ifaces,
                        }
                    })
                    .await
                    {
                        sample_count += 1;
                        let _ = app_clone.emit(IPC_EVENT_MONITOR_SAMPLE, snapshot);
                    }
                    if sample_count == 1 {
                        650
                    } else {
                        interval_atom.load(Ordering::Relaxed)
                    }
                } else {
                    if !ssh_clone.has_session(&session_id).await {
                        break;
                    }
                    match ssh_clone
                        .exec_command(&session_id, PROBE_COMMAND, 6000)
                        .await
                    {
                        Ok(raw_output) => {
                            if stopped.load(Ordering::Relaxed) {
                                break;
                            }
                            let now = now_ms();
                            let sections = split_sections(&raw_output);
                            let (cpu_raw, cpu_cores) = parse_cpu_section(
                                sections.get("CPU").map(String::as_str).unwrap_or(""),
                            );
                            let mem = parse_mem_section(
                                sections.get("MEM").map(String::as_str).unwrap_or(""),
                            );
                            let (load_average, uptime_seconds) = parse_load_section(
                                sections.get("LOAD").map(String::as_str).unwrap_or(""),
                            );
                            let net_raw = parse_net_section(
                                sections.get("NET").map(String::as_str).unwrap_or(""),
                            );
                            let disks = parse_disk_section(
                                sections.get("DISK").map(String::as_str).unwrap_or(""),
                            );
                            let (hostname, kernel, os_pretty_name) = parse_sys_section(
                                sections.get("SYS").map(String::as_str).unwrap_or(""),
                            );

                            let mut cpu_usage_percent = 0.0;
                            if let (Some(cur), Some(prev)) = (cpu_raw, prev_cpu) {
                                let d_total = cur.total.saturating_sub(prev.total);
                                let d_idle = cur.idle.saturating_sub(prev.idle);
                                if d_total > 0 {
                                    cpu_usage_percent = (((d_total.saturating_sub(d_idle)) as f64
                                        / d_total as f64)
                                        * 100.0)
                                        .clamp(0.0, 100.0);
                                }
                            }
                            prev_cpu = cpu_raw;

                            let mut net_rx_bytes_per_sec = 0.0;
                            let mut net_tx_bytes_per_sec = 0.0;
                            let mut net_interfaces = Vec::new();

                            if let Some((prev_ts, ref prev_map)) = prev_net {
                                let delta_sec = ((now - prev_ts) as f64 / 1000.0).max(0.1);
                                for (iface, (cur_rx, cur_tx)) in &net_raw {
                                    if let Some((p_rx, p_tx)) = prev_map.get(iface) {
                                        let rx_rate =
                                            (cur_rx.saturating_sub(*p_rx)) as f64 / delta_sec;
                                        let tx_rate =
                                            (cur_tx.saturating_sub(*p_tx)) as f64 / delta_sec;
                                        net_rx_bytes_per_sec += rx_rate;
                                        net_tx_bytes_per_sec += tx_rate;
                                        net_interfaces.push(NetInterfaceRate {
                                            name: iface.clone(),
                                            rx_bytes_per_sec: rx_rate,
                                            tx_bytes_per_sec: tx_rate,
                                        });
                                    }
                                }
                                net_interfaces.sort_by(|a, b| {
                                    (b.rx_bytes_per_sec + b.tx_bytes_per_sec)
                                        .partial_cmp(&(a.rx_bytes_per_sec + a.tx_bytes_per_sec))
                                        .unwrap_or(std::cmp::Ordering::Equal)
                                });
                            } else {
                                for iface in net_raw.keys() {
                                    net_interfaces.push(NetInterfaceRate {
                                        name: iface.clone(),
                                        rx_bytes_per_sec: 0.0,
                                        tx_bytes_per_sec: 0.0,
                                    });
                                }
                            }
                            net_interfaces.truncate(4);
                            prev_net = Some((now, net_raw));
                            sample_count += 1;

                            let snapshot = HostMetricsSnapshot {
                                session_id: session_id.clone(),
                                timestamp: now,
                                hostname,
                                os_pretty_name,
                                kernel,
                                uptime_seconds,
                                cpu_cores,
                                cpu_usage_percent,
                                load_average,
                                mem_total_bytes: mem.mem_total_bytes,
                                mem_used_bytes: mem.mem_used_bytes,
                                mem_available_bytes: mem.mem_available_bytes,
                                mem_usage_percent: mem.mem_usage_percent,
                                swap_total_bytes: mem.swap_total_bytes,
                                swap_used_bytes: mem.swap_used_bytes,
                                swap_usage_percent: mem.swap_usage_percent,
                                disks,
                                net_rx_bytes_per_sec,
                                net_tx_bytes_per_sec,
                                net_interfaces,
                            };
                            let _ = app_clone.emit(IPC_EVENT_MONITOR_SAMPLE, snapshot);
                            if sample_count == 1 {
                                650
                            } else {
                                interval_atom.load(Ordering::Relaxed)
                            }
                        }
                        Err(err_msg) => {
                            if !stopped.load(Ordering::Relaxed) {
                                let _ = app_clone.emit(
                                    IPC_EVENT_MONITOR_ERROR,
                                    MonitorErrorEvent {
                                        session_id: session_id.clone(),
                                        error: err_msg,
                                        timestamp: now_ms(),
                                    },
                                );
                            }
                            interval_atom.load(Ordering::Relaxed).max(4000)
                        }
                    }
                };

                if stopped.load(Ordering::Relaxed) {
                    break;
                }

                if let Some(ref closed) = closed_notify {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(next_delay_ms)) => {}
                        _ = wake_notify.notified() => {}
                        _ = closed.notified() => { break; }
                    }
                } else {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(next_delay_ms)) => {}
                        _ = wake_notify.notified() => {}
                    }
                }
            }

            monitors_map.write().await.remove(&session_id);
        });

        Ok(())
    }

    pub async fn stop(&self, session_id: &str) {
        if let Some(h) = self.monitors.write().await.remove(session_id) {
            h.stopped.store(true, Ordering::Relaxed);
            h.wake_notify.notify_waiters();
        }
    }

    pub async fn stop_all(&self) {
        let mut guard = self.monitors.write().await;
        for (_, h) in guard.drain() {
            h.stopped.store(true, Ordering::Relaxed);
            h.wake_notify.notify_waiters();
        }
    }
}
