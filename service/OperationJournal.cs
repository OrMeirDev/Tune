// Durable results for the fixed service operations. This class never executes an operation.
// Production storage is the installer's protected journal folder, shared by service versions.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

namespace Tune
{
    internal sealed class OperationJournal
    {
        readonly string root, instance;
        readonly bool requireProtectedFolder;
        readonly int maxRecords;
        readonly long maxBytes;
        readonly object gate = new object();
        readonly HashSet<string> active = new HashSet<string>();
        const int MaxRecordBytes = 1024 * 1024;

        internal OperationJournal(string root, string instance, bool requireProtectedFolder, int maxRecords = 10000, long maxBytes = 64 * 1024 * 1024)
        {
            this.root = root; this.instance = instance; this.requireProtectedFolder = requireProtectedFolder;
            this.maxRecords = maxRecords; this.maxBytes = maxBytes;
        }
        static string Id(string value)
        {
            Guid id;
            if (!Guid.TryParseExact(value, "D", out id)) throw new ArgumentException("invalid operation id");
            return id.ToString("D");
        }
        void AssertDirectory()
        {
            if (!requireProtectedFolder) Directory.CreateDirectory(root); // isolated console/test copy only
            if (!Directory.Exists(root) || (File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("protected operation journal is unavailable");
            if (!requireProtectedFolder) return;
            var acl = Directory.GetAccessControl(root);
            string owner = acl.GetOwner(typeof(SecurityIdentifier)).Value;
            if (owner != "S-1-5-18" && owner != "S-1-5-32-544") throw new IOException("operation journal has an untrusted owner");
            var writes = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                if (rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & writes) != 0 &&
                    rule.IdentityReference.Value != "S-1-5-18" && rule.IdentityReference.Value != "S-1-5-32-544")
                    throw new IOException("operation journal is writable by an untrusted account");
        }
        Dictionary<string, object> Read(string id)
        {
            AssertDirectory();
            string file = Path.Combine(root, id + ".json");
            if (!File.Exists(file)) return null;
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0 || new FileInfo(file).Length > MaxRecordBytes)
                throw new IOException("invalid operation journal record");
            var r = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
            if (r == null || !r.ContainsKey("id") || Convert.ToString(r["id"]) != id ||
                !r.ContainsKey("callerSid") || !r.ContainsKey("requestHash") || !r.ContainsKey("state") || !r.ContainsKey("instance"))
                throw new IOException("invalid operation journal record");
            return r;
        }
        void Write(Dictionary<string, object> record)
        {
            AssertDirectory();
            byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(record));
            if (bytes.Length > MaxRecordBytes) throw new IOException("operation result exceeds journal limit");
            string file = Path.Combine(root, Id(Convert.ToString(record["id"])) + ".json");
            var files = new DirectoryInfo(root).GetFiles("*.json");
            long oldSize = File.Exists(file) ? new FileInfo(file).Length : 0;
            // Do not evict old IDs silently: that could make a duplicate request execute again.
            if ((!File.Exists(file) && files.Length >= maxRecords) || files.Sum(f => f.Length) - oldSize + bytes.Length > maxBytes)
                throw new IOException("operation journal is full; an administrator must archive it before new changes");
            string tmp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file);
            }
            finally { if (File.Exists(tmp)) File.Delete(tmp); }
        }
        // null = a new request durably accepted. Otherwise return the old record, never run again.
        internal Dictionary<string, object> Begin(string value, string op, string callerSid, uint pid, string image, string hash)
        {
            string id = Id(value);
            if (String.IsNullOrEmpty(callerSid)) throw new UnauthorizedAccessException("caller identity unavailable");
            lock (gate)
            {
                var previous = Read(id);
                if (previous != null)
                {
                    if (Convert.ToString(previous["callerSid"]) != callerSid || Convert.ToString(previous["requestHash"]) != hash)
                        throw new InvalidOperationException("operation id belongs to another request");
                    return Public(previous);
                }
                var record = new Dictionary<string, object> {
                    { "id", id }, { "op", op }, { "callerSid", callerSid }, { "callerPid", pid }, { "callerImage", image },
                    { "requestHash", hash }, { "startedAt", DateTime.UtcNow.ToString("o") },
                    { "instance", instance }, { "state", "running" }
                };
                Write(record); // before the caller is allowed to resume an operation process
                active.Add(id);
                return null;
            }
        }
        internal Dictionary<string, object> Finish(string value, string answer)
        {
            string id = Id(value);
            lock (gate)
            {
                try
                {
                    var result = new JavaScriptSerializer().DeserializeObject(answer) as Dictionary<string, object>;
                    if (result == null || !result.ContainsKey("ok") || !(result["ok"] is bool)) throw new IOException("invalid operation result");
                    var record = Read(id);
                    if (record == null) throw new IOException("operation was not recorded");
                    result["operationId"] = id;
                    bool unknown = (result.ContainsKey("code") && Convert.ToString(result["code"]) == "noAnswer") ||
                        (result.ContainsKey("stopped") && result["stopped"] is bool && !(bool)result["stopped"]);
                    record["state"] = (bool)result["ok"] ? "completed" : unknown ? "unknown" : "failed";
                    record["result"] = result;
                    record["finishedAt"] = DateTime.UtcNow.ToString("o");
                    Write(record); // publish a result only after it is durable
                    return result;
                }
                finally { active.Remove(id); }
            }
        }
        internal Dictionary<string, object> Status(string value, string callerSid)
        {
            lock (gate)
            {
                var record = Read(Id(value));
                return record == null || Convert.ToString(record["callerSid"]) != callerSid ? null : Public(record);
            }
        }
        Dictionary<string, object> Public(Dictionary<string, object> record)
        {
            var result = new Dictionary<string, object>();
            foreach (string key in new[] { "id", "op", "state", "startedAt", "finishedAt", "result" })
                if (record.ContainsKey(key)) result[key] = record[key];
            if (Convert.ToString(record["state"]) == "running")
                result["state"] = Convert.ToString(record["instance"]) != instance ? "interrupted" :
                    active.Contains(Convert.ToString(record["id"])) ? "running" : "unknown";
            return result;
        }
    }
}
