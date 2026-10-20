// Execute the journal's real C# implementation. The only writes are to this test's own temp folder.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
test('the real service journal: persistence, duplicate IDs, ownership, interruption and fail-closed storage', { skip: process.platform !== 'win32' && 'needs Windows C# compiler' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-journal-unit-'));
  const source = String.raw`
using System; using System.IO; using System.Collections.Generic; using System.Security.Principal; using Tune;
class TestJournal {
  static int count;
  static void Check(bool ok, string name) { if (!ok) throw new Exception(name); count++; Console.WriteLine("PASS " + name); }
  static bool Throws(Action action) { try { action(); return false; } catch { return true; } }
  static void Main() {
    string root = @"__ROOT__", id = "11111111-2222-4333-8444-555555555555", two = "22222222-2222-4333-8444-555555555555", three = "33333333-2222-4333-8444-555555555555";
    var j = new OperationJournal(root, "instance-one", false);
    Check(j.Begin(id, "drivers", "owner", 42, "Tune", "hash") == null && File.ReadAllText(Path.Combine(root,id+".json")).Contains("running"), "accepted ID persisted before execution");
    Check(j.Begin(id, "drivers", "owner", 42, "Tune", "hash") != null, "duplicate is returned rather than accepted again");
    Check(Throws(() => j.Begin(id, "drivers", "owner", 42, "Tune", "different")), "ID cannot change its request");
    Check(j.Status(id, "other user") == null, "status is scoped to the Windows caller");
    var result = j.Finish(id, @"{""ok"":true,""data"":{""restore"":""created"",""reboot"":true,""results"":[{""id"":""driver"",""code"":2}]}}");
    var data = (Dictionary<string,object>)result["data"];
    Check((bool)data["reboot"] && (string)data["restore"] == "created" && ((object[])data["results"]).Length == 1, "per-driver, restore and reboot results retained");
    j.Begin(two, "clean", "owner", 42, "Tune", "second");
    var next = new OperationJournal(root, "instance-two", false);
    Check((string)next.Status(two,"owner")["state"] == "interrupted" && (string)next.Status(id,"owner")["state"] == "completed", "restart distinguishes unknown and completed outcomes");
    Check(Throws(() => j.Finish(two, "bad JSON")) && (string)j.Status(two,"owner")["state"] == "unknown", "invalid result is not a success or a running operation");
    File.WriteAllText(Path.Combine(root,three+".json"), "{broken");
    Check(Throws(() => j.Begin(three,"clean","owner",42,"Tune","third")) && File.ReadAllText(Path.Combine(root,three+".json")) == "{broken", "corrupt evidence is never overwritten");
    var budget = new OperationJournal(Path.Combine(root,"budget"), "bounded", false, 1);
    budget.Begin(id,"clean","owner",42,"Tune","one");
    Check(Throws(() => budget.Begin(two,"clean","owner",42,"Tune","two")) && budget.Status(id,"owner") != null, "full journal refuses work rather than evicting IDs");
    string untrusted = Path.Combine(root,"untrusted"); Directory.CreateDirectory(untrusted);
    var acl = Directory.GetAccessControl(untrusted); acl.SetOwner(WindowsIdentity.GetCurrent().User); Directory.SetAccessControl(untrusted,acl);
    var protectedJournal = new OperationJournal(untrusted,"production",true);
    Check(Throws(() => protectedJournal.Begin(id,"clean","owner",42,"Tune","one")), "production journal rejects a user-owned folder");
    Check(Directory.GetFiles(root,"*.tmp",SearchOption.AllDirectories).Length == 0, "atomic writes leave no temporary files");
    Console.WriteLine("JOURNAL_CASES " + count);
  }
}
`.replace('__ROOT__', dir.replace(/"/g, '""'));
  try {
    const input = path.join(dir, 'Test.cs'), exe = path.join(dir, 'Test.exe');
    fs.writeFileSync(input, source);
    execFileSync(path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), [
      '/nologo', '/r:System.Web.Extensions.dll', '/r:System.Core.dll', '/out:' + exe, path.join(__dirname, '..', 'service', 'OperationJournal.cs'), input,
    ], { encoding: 'utf8', timeout: 30000 });
    const output = execFileSync(exe, [], { encoding: 'utf8', timeout: 30000 });
    assert.match(output, /JOURNAL_CASES 11/); console.log(output.trim());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
