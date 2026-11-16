namespace FindMyType;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // One window at a time: a second launch just exits.
        using var single = new Mutex(true, "FindMyType.SingleInstance", out var first);
        if (!first) return;

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
