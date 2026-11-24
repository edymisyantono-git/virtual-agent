using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

namespace VirtualCompany.Core;

/// Keeps projects in memory, persists them under data/projects/{id}, and fans events out to SSE listeners.
public class ProjectStore
{
    private readonly string _root;
    private readonly ConcurrentDictionary<string, Project> _projects = new();
    private readonly ConcurrentDictionary<string, List<Channel<VcEvent>>> _listeners = new();

    public ProjectStore(string root)
    {
        _root = root;
        Directory.CreateDirectory(_root);
        foreach (var dir in Directory.GetDirectories(_root))
        {
            var file = Path.Combine(dir, "project.json");
            if (!File.Exists(file)) continue;
            try
            {
                var p = JsonSerializer.Deserialize<Project>(File.ReadAllText(file), AgentRegistry.Json);
                if (p == null) continue;
                // A restart interrupts any running pipeline; mark it so the UI does not wait forever.
                var dirty = false;
                if (p.Status is ProjectStatus.Running or ProjectStatus.WaitingGate or ProjectStatus.WaitingCustomer)
                {
                    p.Status = ProjectStatus.Stopped;
                    p.PendingGate = null; p.PendingQuestion = null;
                    p.Events.Add(new VcEvent { Seq = p.Events.Count + 1, Type = "log", Data = new() { ["level"] = "warn", ["text"] = "The server restarted while this project was running, so it was paused. Press Resume to continue." } });
                    dirty = true;
                }
                // The screen rebuilds itself by replaying events, so the last status event must match the saved status.
                // (Older files were saved as Stopped after a restart without such an event and showed "Running" forever.)
                var lastStatus = p.Events.LastOrDefault(e => e.Type == "status")?.Data.GetValueOrDefault("status")?.ToString();
                if (p.Events.Count > 0 && lastStatus != p.Status.ToString())
                {
                    p.Events.Add(new VcEvent { Seq = p.Events.Count + 1, Type = "status", Data = new() { ["status"] = p.Status.ToString() } });
                    dirty = true;
                }
                if (dirty) File.WriteAllText(file, JsonSerializer.Serialize(p, AgentRegistry.Json));
                _projects[p.Id] = p;
            }
            catch (JsonException) { /* skip unreadable project files */ }
        }
    }

    public IEnumerable<Project> All => _projects.Values.OrderByDescending(p => p.CreatedAt);

    public Project? Get(string id) => _projects.TryGetValue(id, out var p) ? p : null;

    public Project Create()
    {
        var id = "PRJ-" + DateTime.Now.ToString("yyMMdd-HHmmss");
        var p = new Project { Id = id };
        _projects[id] = p;
        Save(p);
        return p;
    }

    public void Save(Project p)
    {
        lock (p)
        {
            var dir = Path.Combine(_root, p.Id);
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "project.json"), JsonSerializer.Serialize(p, AgentRegistry.Json));
        }
    }

    public string AppDir(Project p) => Path.Combine(_root, p.Id, "app");

    public string ArtifactPath(Project p, string name) => Path.Combine(_root, p.Id, "artifacts", Path.GetFileName(name));

    public void WriteArtifact(Project p, ArtifactRef a, string content)
    {
        var path = ArtifactPath(p, a.Name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        lock (p) p.Artifacts.Add(a);
    }

    public string? ReadArtifact(Project p, string name)
    {
        var path = ArtifactPath(p, name);
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }

    public void Publish(Project p, string type, object data)
    {
        var dict = JsonSerializer.Deserialize<Dictionary<string, object?>>(JsonSerializer.Serialize(data, AgentRegistry.Json), AgentRegistry.Json) ?? new();
        var ev = new VcEvent { Type = type, Data = dict };
        lock (p)
        {
            ev.Seq = p.Events.Count + 1;
            p.Events.Add(ev);
            // Broadcast inside the project lock so listeners receive events in Seq order.
            if (_listeners.TryGetValue(p.Id, out var list))
                lock (list)
                    foreach (var ch in list) ch.Writer.TryWrite(ev);
        }
    }

    public List<VcEvent> Snapshot(Project p)
    {
        lock (p) return p.Events.ToList();
    }

    public ChannelReader<VcEvent> Subscribe(string projectId, out Action unsubscribe)
    {
        var ch = Channel.CreateUnbounded<VcEvent>();
        var list = _listeners.GetOrAdd(projectId, _ => new());
        lock (list) list.Add(ch);
        unsubscribe = () => { lock (list) list.Remove(ch); ch.Writer.TryComplete(); };
        return ch.Reader;
    }
}
