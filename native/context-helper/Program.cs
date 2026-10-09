using System.IO;
using System.Windows.Automation.Text;
using System.Windows.Automation;
using System.Text.Json;
using System.Runtime.InteropServices;

internal static class Program {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [STAThread] static void Main(string[] args) {
  if(args.Length!=1)return;
  string file=Path.GetFullPath(args[0]);Directory.CreateDirectory(Path.GetDirectoryName(file)!);
  using var wake=new AutoResetEvent(false);
  Automation.AddAutomationFocusChangedEventHandler((sender,eventArgs)=>wake.Set());
  while(true){
   object state;
   try {
    var e=AutomationElement.FocusedElement;
    var window=GetForegroundWindow().ToInt64();
    string docId=window+":"+e.Current.ProcessId+":"+string.Join(".",e.GetRuntimeId());
    if(e.Current.IsPassword)state=new{supported=false,reason="password",docId,timestamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};
    else if((e.Current.ControlType==ControlType.Edit||e.Current.ControlType==ControlType.Document)&&e.TryGetCurrentPattern(TextPattern.Pattern,out var pattern)){
     var text=(TextPattern)pattern;var selection=text.GetSelection();
     if(selection.Length!=1)throw new InvalidOperationException("No single caret range");
     var caret=selection[0];
     var before=caret.Clone();before.MoveEndpointByRange(TextPatternRangeEndpoint.End,caret,TextPatternRangeEndpoint.Start);before.MoveEndpointByUnit(TextPatternRangeEndpoint.Start,TextUnit.Character,-256);
     var after=caret.Clone();after.MoveEndpointByRange(TextPatternRangeEndpoint.Start,caret,TextPatternRangeEndpoint.End);after.MoveEndpointByUnit(TextPatternRangeEndpoint.End,TextUnit.Character,128);
     // Exclude the selected span: the next commit replaces that span.
     state=new{supported=true,before=before.GetText(1024),after=after.GetText(512),docId,timestamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};
    } else state=new{supported=false,reason="text-pattern-unavailable",docId,timestamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};
   }catch{state=new{supported=false,reason="focus-unavailable",timestamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};}
   try{File.WriteAllText(file+".tmp",JsonSerializer.Serialize(state));File.Move(file+".tmp",file,true);}catch{}
   wake.WaitOne(200);
  }
 }
}
