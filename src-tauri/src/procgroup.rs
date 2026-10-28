//! Lets a command and everything it starts be killed together, so a cancelled or timed-out
//! command can't leave children running, and so a leftover child can't hold the output pipe
//! open forever.
//!
//! Unix: the command gets its own process group and we `killpg` it.
//! Windows: the command is put in a Job Object and we terminate the job. A job (unlike
//! `taskkill /T`) still finds grandchildren after their parent has exited, which is what the
//! "kill strays after a normal exit" case needs.

use std::process::{Child, Command};

#[cfg(unix)]
pub struct ProcessGroup {
    pgid: i32,
}

#[cfg(unix)]
impl ProcessGroup {
    /// Call before spawning.
    pub fn configure(cmd: &mut Command) {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // its own group, so we can stop everything it starts
    }

    /// Call right after spawning.
    pub fn attach(child: &Child) -> Self {
        ProcessGroup { pgid: child.id() as i32 }
    }

    /// Kills every process still in the group. Safe to call more than once.
    pub fn kill(&self) {
        unsafe {
            libc::killpg(self.pgid, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
pub struct ProcessGroup {
    /// None if the process couldn't be put in a job (for example it already belongs to a job
    /// that forbids nesting); then we fall back to `taskkill /T`.
    job: Option<windows_sys::Win32::Foundation::HANDLE>,
    pid: u32,
}

#[cfg(windows)]
impl ProcessGroup {
    /// Call before spawning. CREATE_NO_WINDOW stops a console window flashing up.
    pub fn configure(cmd: &mut Command) {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }

    /// Call right after spawning. A process started in the instant before this runs is not in
    /// the job; for a shell that has only just begun to start up, that window is negligible.
    pub fn attach(child: &Child) -> Self {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        let pid = child.id();
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return ProcessGroup { job: None, pid };
            }
            // If billybot itself dies, the job closes and Windows kills what is left in it.
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                CloseHandle(job);
                return ProcessGroup { job: None, pid };
            }
            ProcessGroup { job: Some(job), pid }
        }
    }

    /// Kills every process still in the job. Safe to call more than once.
    pub fn kill(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        match self.job {
            Some(job) => unsafe {
                TerminateJobObject(job, 1);
            },
            None => {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &self.pid.to_string()])
                    .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
                    .output();
            }
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Some(job) = self.job {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(job);
            }
        }
    }
}
