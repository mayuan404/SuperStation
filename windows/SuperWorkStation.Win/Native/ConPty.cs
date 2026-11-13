using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace SuperWorkStation;

internal interface IPtySession : IDisposable
{
    void Write(byte[] data);
    void Resize(int cols, int rows);
}

/// <summary>Windows 伪终端（ConPTY）会话：本地 shell / 系统自带 ssh.exe 都跑在这里。</summary>
internal sealed class ConPty : IPtySession
{
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;
    private const uint INFINITE = 0xFFFFFFFF;

    private readonly IntPtr _hpc;
    private readonly IntPtr _process;
    private readonly FileStream _input;
    private readonly FileStream _output;
    private readonly object _writeLock = new();
    private bool _closed;

    private readonly Action<byte[]> _onData;
    private readonly Action<int> _onExit;

    private ConPty(IntPtr hpc, IntPtr process, FileStream input, FileStream output,
        Action<byte[]> onData, Action<int> onExit)
    {
        _hpc = hpc;
        _process = process;
        _input = input;
        _output = output;
        _onData = onData;
        _onExit = onExit;
        _ = Task.Run(ReadLoop);
        _ = Task.Run(WaitLoop);
    }

    public static ConPty? Start(string exe, IReadOnlyList<string> args, string? cwd,
        IDictionary<string, string> env, int cols, int rows,
        Action<byte[]> onData, Action<int> onExit, out string? error)
    {
        error = null;
        var size = new COORD
        {
            X = (short)Math.Max(20, cols),
            Y = (short)Math.Max(4, rows)
        };

        if (!CreatePipe(out var inRead, out var inWrite, IntPtr.Zero, 0))
        {
            error = "CreatePipe 失败: " + Marshal.GetLastWin32Error();
            return null;
        }
        if (!CreatePipe(out var outRead, out var outWrite, IntPtr.Zero, 0))
        {
            CloseHandle(inRead); CloseHandle(inWrite);
            error = "CreatePipe 失败: " + Marshal.GetLastWin32Error();
            return null;
        }

        var hr = CreatePseudoConsole(size, inRead, outWrite, 0, out var hpc);
        CloseHandle(inRead);
        CloseHandle(outWrite);
        if (hr != 0)
        {
            CloseHandle(inWrite); CloseHandle(outRead);
            error = "CreatePseudoConsole 失败: 0x" + hr.ToString("X");
            return null;
        }

        var attributeSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
        var attributeList = Marshal.AllocHGlobal(attributeSize);
        var processInfo = new PROCESS_INFORMATION();
        IntPtr envBlock = IntPtr.Zero;
        try
        {
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
            {
                error = "InitializeProcThreadAttributeList 失败";
                return null;
            }
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                    hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            {
                error = "UpdateProcThreadAttribute 失败: " + Marshal.GetLastWin32Error();
                return null;
            }

            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
            startup.lpAttributeList = attributeList;

            var commandLine = new StringBuilder(BuildCommandLine(exe, args));
            envBlock = BuildEnvironment(env);

            var ok = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                envBlock, string.IsNullOrEmpty(cwd) ? null : cwd,
                ref startup, out processInfo);
            if (!ok)
            {
                error = "CreateProcess 失败: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
                return null;
            }
        }
        finally
        {
            if (envBlock != IntPtr.Zero) Marshal.FreeHGlobal(envBlock);
            DeleteProcThreadAttributeList(attributeList);
            Marshal.FreeHGlobal(attributeList);
        }

        var input = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(inWrite, true),
            FileAccess.Write, 4096, false);
        var output = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(outRead, true),
            FileAccess.Read, 4096, false);
        return new ConPty(hpc, processInfo.hProcess, input, output, onData, onExit);
    }

    private void ReadLoop()
    {
        var buffer = new byte[32 * 1024];
        try
        {
            while (true)
            {
                var read = _output.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                _onData(buffer[..read]);
            }
        }
        catch
        {
            // 终端被关闭
        }
    }

    private void WaitLoop()
    {
        try
        {
            WaitForSingleObject(_process, INFINITE);
            GetExitCodeProcess(_process, out var code);
            // 给读取端一点时间把缓冲刷完，再报退出
            Thread.Sleep(80);
            _onExit((int)code);
        }
        catch
        {
            _onExit(-1);
        }
    }

    public void Write(byte[] data)
    {
        lock (_writeLock)
        {
            if (_closed) return;
            try
            {
                _input.Write(data, 0, data.Length);
                _input.Flush();
            }
            catch
            {
                // 进程已退出
            }
        }
    }

    public void Resize(int cols, int rows)
    {
        if (_closed) return;
        var size = new COORD
        {
            X = (short)Math.Max(20, cols),
            Y = (short)Math.Max(4, rows)
        };
        ResizePseudoConsole(_hpc, size);
    }

    public void Dispose()
    {
        if (_closed) return;
        _closed = true;
        try { TerminateProcess(_process, 0); } catch { }
        try { ClosePseudoConsole(_hpc); } catch { }
        try { _input.Dispose(); } catch { }
        try { _output.Dispose(); } catch { }
        try { CloseHandle(_process); } catch { }
    }

    private static string BuildCommandLine(string exe, IReadOnlyList<string> args)
    {
        var sb = new StringBuilder();
        sb.Append(QuoteArg(exe));
        foreach (var arg in args)
        {
            sb.Append(' ').Append(QuoteArg(arg));
        }
        return sb.ToString();
    }

    private static string QuoteArg(string arg)
    {
        if (arg.Length == 0) return "\"\"";
        if (arg.IndexOfAny([' ', '\t', '"']) < 0) return arg;
        var sb = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            sb.Append('\\', backslashes);
            backslashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static IntPtr BuildEnvironment(IDictionary<string, string> overrides)
    {
        var merged = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            var key = entry.Key?.ToString() ?? "";
            if (key.Length == 0 || key[0] == '=') continue;
            merged[key] = entry.Value?.ToString() ?? "";
        }
        foreach (var pair in overrides)
        {
            if (pair.Key.StartsWith("__", StringComparison.Ordinal)) continue;
            merged[pair.Key] = pair.Value;
        }
        merged["TERM"] = "xterm-256color";
        merged["COLORTERM"] = "truecolor";

        var sb = new StringBuilder();
        foreach (var pair in merged.OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase))
        {
            sb.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        }
        sb.Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll")]
    private static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute,
        IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string? lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string? lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
}
