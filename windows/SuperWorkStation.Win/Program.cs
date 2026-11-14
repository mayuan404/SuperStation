using System.Windows.Forms;

namespace SuperWorkStation;

internal static class Program
{
    public const string Version = "0.4.0";

    [STAThread]
    private static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            AppPaths.Log("UNHANDLED " + e.ExceptionObject);
        Application.ThreadException += (_, e) =>
            AppPaths.Log("THREAD " + e.Exception);

        Application.Run(new MainForm());
    }
}
