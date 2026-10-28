// The webview reports the OS it runs on (WebView2 on Windows, WebKit on macOS and Linux).
export const isWindows = navigator.userAgent.includes("Windows");
export const isMac = navigator.userAgent.includes("Macintosh");

/** What the user calls this computer, and where the API key is kept, for on-screen text. */
export const computerName = isMac ? "Mac" : "computer";
export const keyStoreName = isMac ? "macOS Keychain" : isWindows ? "Windows Credential Manager" : "your system keyring";
