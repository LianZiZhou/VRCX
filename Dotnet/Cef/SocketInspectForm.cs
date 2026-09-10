using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using CefSharp;
using CefSharp.WinForms;
using NLog;

namespace VRCX
{
    /// <summary>
    /// [hub] A window that shows the main window's socket traffic live: the
    /// VRChat pipeline, the Hub link's events and this machine's uplinks.
    /// Opened from the tray menu, next to DevTools.
    ///
    /// The page has no bindings of its own. The main window's renderer
    /// records every message (src/hub/client/socketInspector.js) and, while
    /// this window is open, hands each one to <see cref="AppApiCef.SocketInspectPush"/>,
    /// which forwards it here with ExecuteScriptAsync. Opening the window
    /// turns that tap on in the main window and closing it turns it off, so
    /// the interop cost is zero while nobody is looking.
    /// </summary>
    public class SocketInspectForm : WinformBase
    {
        public static SocketInspectForm Instance;
        private static readonly Logger logger = LogManager.GetCurrentClassLogger();
        public ChromiumWebBrowser Browser;

        /// <summary>
        /// Show the window, creating it on first use. Safe from any thread.
        /// </summary>
        public static void Open()
        {
            var main = MainForm.Instance;
            if (main == null)
                return;
            if (main.InvokeRequired)
            {
                main.BeginInvoke(new Action(Open));
                return;
            }
            if (Instance == null || Instance.IsDisposed)
                Instance = new SocketInspectForm();
            Instance.Show();
            if (Instance.WindowState == FormWindowState.Minimized)
                Instance.WindowState = FormWindowState.Normal;
            Instance.Activate();
        }

        /// <summary>
        /// One recorded message from the main window, as JSON. Dropped when
        /// the window is not open.
        /// </summary>
        public static void Push(string json)
        {
            var form = Instance;
            var browser = form?.Browser;
            if (form == null || form.IsDisposed || browser == null || !browser.CanExecuteJavascriptInMainFrame)
                return;
            browser.ExecuteScriptAsync("window.__socketInspect?.push", json);
        }

        private SocketInspectForm()
        {
            Text = "VRCX Socket Inspect";
            Name = "SocketInspectForm";
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1100, 700);
            MinimumSize = new Size(480, 320);
            try
            {
                var path = Path.GetDirectoryName(Environment.ProcessPath) ?? string.Empty;
                Icon = new Icon(Path.Combine(path, "VRCX.ico"));
            }
            catch (Exception ex)
            {
                logger.Error(ex);
            }

            Browser = new ChromiumWebBrowser(Program.LaunchDebug ? "http://localhost:9000/socket-inspect.html" : "file://vrcx/socket-inspect.html")
            {
                MenuHandler = new CustomMenuHandler(),
                RequestHandler = new CustomRequestHandler(),
                BrowserSettings =
                {
                    DefaultEncoding = "UTF-8",
                },
                Dock = DockStyle.Fill
            };
            Browser.LoadingStateChanged += (_, args) =>
            {
                // The page is ready to receive: turn the main window's tap on,
                // which replays the buffered history first.
                if (!args.IsLoading)
                    SetMainWindowTap(true);
            };
            FormClosed += (_, _) =>
            {
                SetMainWindowTap(false);
                if (Instance == this)
                    Instance = null;
            };
            Controls.Add(Browser);
        }

        private static void SetMainWindowTap(bool enabled)
        {
            var browser = MainForm.Instance?.Browser;
            if (browser == null || !browser.CanExecuteJavascriptInMainFrame)
                return;
            browser.ExecuteScriptAsync($"window.__vrcxSocketInspect?.setEnabled({(enabled ? "true" : "false")})");
        }
    }
}
