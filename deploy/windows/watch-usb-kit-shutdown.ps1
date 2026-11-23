$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies ([System.Windows.Forms.NativeWindow].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

public sealed class EventPosShutdownWindow : NativeWindow {
    private const int WM_QUERYENDSESSION = 0x0011;
    private const int WM_ENDSESSION = 0x0016;
    private const int WM_CLOSE = 0x0010;
    private const long SpecialEndSession = 0xC0000001L; // logoff, critical, or Restart Manager
    private readonly Task launcherClosed;
    private bool waitingReasonRegistered;

    [DllImport("kernel32.dll")]
    private static extern bool SetProcessShutdownParameters(uint level, uint flags);

    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true)]
    private static extern bool PostMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool ShutdownBlockReasonCreate(IntPtr hwnd, string reason);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool ShutdownBlockReasonDestroy(IntPtr hwnd);

    private EventPosShutdownWindow(Task launcherClosed) {
        this.launcherClosed = launcherClosed;
        CreateHandle(new CreateParams { Caption = "Event POS USB kit" });
    }

    private void ClearWaitingReason() {
        if (!waitingReasonRegistered) return;
        ShutdownBlockReasonDestroy(Handle);
        waitingReasonRegistered = false;
    }

    protected override void WndProc(ref Message message) {
        switch (message.Msg) {
            case WM_QUERYENDSESSION:
                if (!waitingReasonRegistered && !launcherClosed.IsCompleted &&
                    (message.LParam.ToInt64() & SpecialEndSession) == 0) {
                    waitingReasonRegistered = ShutdownBlockReasonCreate(Handle,
                        "ぽすりんの会計データをUSBへ保存しています");
                }
                message.Result = new IntPtr(1);
                return;
            case WM_ENDSESSION:
                try {
                    if (message.WParam != IntPtr.Zero) {
                        bool canWait = waitingReasonRegistered &&
                            (message.LParam.ToInt64() & SpecialEndSession) == 0;
                        Console.WriteLine(canWait ? "shutdown-wait" : "shutdown");
                        Console.Out.Flush();
                        launcherClosed.Wait(canWait ? 10000 : 3500);
                        Application.ExitThread();
                    }
                } finally {
                    // Also clear the reason when Windows cancels this shutdown.
                    ClearWaitingReason();
                }
                message.Result = IntPtr.Zero;
                return;
            case WM_CLOSE:
                Application.ExitThread();
                message.Result = IntPtr.Zero;
                return;
        }
        base.WndProc(ref message);
    }

    public static void Run() {
        // Windows delivers this notification before shutting down the launcher at the default level.
        SetProcessShutdownParameters(0x300, 0);
        var launcherClosed = Task.Factory.StartNew(() => Console.ReadLine(), TaskCreationOptions.LongRunning);
        var window = new EventPosShutdownWindow(launcherClosed);
        var handle = window.Handle;
        launcherClosed.ContinueWith(_ => { PostMessage(handle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); });
        try { Application.Run(); }
        finally {
            window.ClearWaitingReason();
            window.DestroyHandle();
        }
    }
}
'@
[EventPosShutdownWindow]::Run()
