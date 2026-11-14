using Windows.Data.Pdf;
using Windows.Storage;
using Windows.Storage.Streams;

namespace SuperWorkStation;

/// <summary>PDF：用系统自带的 Windows.Data.Pdf 取页尺寸并把页面渲染成 PNG，交给网页缩放。</summary>
internal static class PdfX
{
    private static string CacheDir
    {
        get
        {
            var dir = Path.Combine(Path.GetTempPath(), "SuperWorkStation", "pdf");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    public static Dictionary<string, object?>? Info(string jsPath)
    {
        var native = PathUtil.FromJs(jsPath);
        if (!File.Exists(native)) return null;
        try
        {
            var doc = Load(native);
            var pages = new List<Dictionary<string, object?>>();
            var count = Math.Min((int)doc.PageCount, 2000);
            for (var i = 0; i < count; i++)
            {
                var page = doc.GetPage((uint)i);
                pages.Add(new Dictionary<string, object?>
                {
                    ["width"] = page.Size.Width,
                    ["height"] = page.Size.Height
                });
            }
            return new Dictionary<string, object?>
            {
                ["count"] = (int)doc.PageCount,
                ["pages"] = pages
            };
        }
        catch (Exception ex)
        {
            AppPaths.Log("PDF info fail " + ex.Message);
            return null;
        }
    }

    public static Dictionary<string, object?>? Render(string jsPath, int page, double width)
    {
        var native = PathUtil.FromJs(jsPath);
        if (!File.Exists(native) || page < 0) return null;
        try
        {
            var doc = Load(native);
            if (page >= (int)doc.PageCount) return null;

            var w = Math.Max(80, Math.Min(3000, width));
            var info = new FileInfo(native);
            var key = $"{PathUtil.StableHash(jsPath)}-{new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeSeconds()}-{page}-{(int)w}";
            var outPath = Path.Combine(CacheDir, key + ".png");

            var target = doc.GetPage((uint)page);
            var height = target.Size.Height * (w / target.Size.Width);
            if (!File.Exists(outPath))
            {
                var bytes = RenderPage(target, (uint)w);
                FsX.WriteAtomic(outPath, bytes);
            }

            return new Dictionary<string, object?>
            {
                ["file"] = PathUtil.ToJs(outPath),
                ["width"] = w,
                ["height"] = height
            };
        }
        catch (Exception ex)
        {
            AppPaths.Log("PDF render fail " + ex.Message);
            return null;
        }
    }

    private static PdfDocument Load(string native)
    {
        var file = StorageFile.GetFileFromPathAsync(native).AsTask().GetAwaiter().GetResult();
        return PdfDocument.LoadFromFileAsync(file).AsTask().GetAwaiter().GetResult();
    }

    private static byte[] RenderPage(PdfPage page, uint width)
    {
        using var stream = new InMemoryRandomAccessStream();
        var options = new PdfPageRenderOptions { DestinationWidth = width };
        page.RenderToStreamAsync(stream, options).AsTask().GetAwaiter().GetResult();
        stream.Seek(0);
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        var size = (uint)stream.Size;
        reader.LoadAsync(size).AsTask().GetAwaiter().GetResult();
        var bytes = new byte[size];
        reader.ReadBytes(bytes);
        return bytes;
    }

    /// <summary>Windows 的 PDF API 不提供文本抽取，AI 面板对 PDF 暂时只能拿到空字符串。</summary>
    public static string Text(string jsPath) => "";
}
