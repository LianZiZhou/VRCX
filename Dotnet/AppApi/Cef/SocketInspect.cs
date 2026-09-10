namespace VRCX
{
    // [hub] The Socket Inspect window's only two entry points from JavaScript.
    public partial class AppApiCef
    {
        /// <summary>
        /// One recorded socket message from the main window, forwarded to the
        /// Socket Inspect window if it is open.
        /// </summary>
        public void SocketInspectPush(string json)
        {
            SocketInspectForm.Push(json);
        }

        /// <summary>
        /// Open the Socket Inspect window, for a button in the app.
        /// </summary>
        public void ShowSocketInspect()
        {
            SocketInspectForm.Open();
        }
    }
}
