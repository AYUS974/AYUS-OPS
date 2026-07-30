import { exec } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execAsync = promisify(exec);

/**
 * AYUS's hands — control the founder's Windows UI like a human, but by ELEMENT
 * NAME (Windows UIAutomation tree), not blind pixel coordinates. Far more
 * reliable than raw vision-clicking.
 *
 * Safety:
 *  - Whole feature is gated behind COMPUTER_USE_ENABLED (see execTool).
 *  - User/model data (element name, text, keys) is passed ONLY via environment
 *    variables to a STATIC base64-encoded PowerShell script — never string-
 *    interpolated — so there is no shell/PS injection surface here.
 *
 * ponytail: enumerates the whole descendant tree of the foreground window and
 * filters in-process; fine for normal windows. If a giant tree (huge web page
 * in a browser) is ever slow, scope the search or cache the tree.
 */

// PowerShell -EncodedCommand wants UTF-16LE base64. Script is static (no user
// data), values ride in via `env`, so this can't be injected into.
async function runPwsh(script, env = {}) {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`,
    { windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 8_000_000 }
  );
  return stdout.trim();
}

// Shared preamble: UIAutomation assemblies + a tiny user32 shim for the
// physical-click fallback, plus a helper that resolves the foreground window's
// AutomationElement (falls back to the whole desktop root).
const PREAMBLE = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class U32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);
}
"@
$AE=[System.Windows.Automation.AutomationElement]
$TS=[System.Windows.Automation.TreeScope]
function Get-Foreground {
  $h=[U32]::GetForegroundWindow()
  $root=$AE::RootElement
  try {
    $cond=New-Object System.Windows.Automation.PropertyCondition($AE::NativeWindowHandleProperty,[int]$h)
    $w=$root.FindFirst($TS::Children,$cond)
    if($w){return $w}
  } catch {}
  return $root
}
`;

// Interactable control types worth showing/clicking. Text/panes excluded.
const WANTED = `@('Button','MenuItem','TabItem','ListItem','CheckBox','RadioButton','Hyperlink','Edit','ComboBox','TreeItem','SplitButton','Document','Slider')`;

/** List named, enabled, on-screen interactable elements of the foreground window. */
export async function uiList() {
  const script = `${PREAMBLE}
$wanted=${WANTED}
$win=Get-Foreground
$all=$win.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$items=New-Object System.Collections.ArrayList
for($i=0;$i -lt $all.Count;$i++){
  try {
    $e=$all.Item($i); $c=$e.Current
    if(-not $c.IsEnabled -or $c.IsOffscreen){continue}
    $n=$c.Name; if([string]::IsNullOrWhiteSpace($n)){continue}
    $t=$c.ControlType.ProgrammaticName -replace '^ControlType\\.',''
    if($wanted -notcontains $t){continue}
    [void]$items.Add([pscustomobject]@{name=$n.Trim(); type=$t})
    if($items.Count -ge 80){break}
  } catch {}
}
$items | ConvertTo-Json -Compress`;
  const out = await runPwsh(script);
  if (!out) return { ok: true, result: "No interactable elements found on the foreground window." };
  let arr;
  try { arr = JSON.parse(out); } catch { return { ok: true, result: out.slice(0, 4000) }; }
  const list = Array.isArray(arr) ? arr : [arr];
  return {
    ok: true,
    result: list.map((x) => `${x.type}: ${x.name}`).join("\n") || "No interactable elements found.",
  };
}

/**
 * Click an element by (partial, case-insensitive) name. Tries Invoke → Toggle →
 * SelectionItem → ExpandCollapse patterns, else physically clicks its centre.
 */
export async function uiClick({ name, type } = {}) {
  if (!name || !String(name).trim()) return { ok: false, error: "name required" };
  const script = `${PREAMBLE}
$name=$env:AYUS_UI_NAME
$type=$env:AYUS_UI_TYPE
$win=Get-Foreground
$all=$win.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$target=$null
for($i=0;$i -lt $all.Count;$i++){
  try {
    $e=$all.Item($i); $c=$e.Current
    if(-not $c.IsEnabled -or $c.IsOffscreen){continue}
    if([string]::IsNullOrWhiteSpace($c.Name)){continue}
    if($c.Name -notlike "*$name*"){continue}
    if($type -and (($c.ControlType.ProgrammaticName -replace '^ControlType\\.','') -notlike "*$type*")){continue}
    $target=$e; break
  } catch {}
}
if(-not $target){ Write-Output 'NOTFOUND'; exit }
$did=$null
foreach($p in @(
  @{P=[System.Windows.Automation.InvokePattern]::Pattern;A={param($x) $x.Invoke()}},
  @{P=[System.Windows.Automation.TogglePattern]::Pattern;A={param($x) $x.Toggle()}},
  @{P=[System.Windows.Automation.SelectionItemPattern]::Pattern;A={param($x) $x.Select()}},
  @{P=[System.Windows.Automation.ExpandCollapsePattern]::Pattern;A={param($x) $x.ExpandCollapse()}}
)){
  $pat=$null
  if($target.TryGetCurrentPattern($p.P,[ref]$pat)){ & $p.A $pat; $did=$p.P.ProgrammaticName; break }
}
if(-not $did){
  $r=$target.Current.BoundingRectangle
  $cx=[int]($r.X+$r.Width/2); $cy=[int]($r.Y+$r.Height/2)
  [U32]::SetCursorPos($cx,$cy)|Out-Null
  [U32]::mouse_event(0x02,0,0,0,0); Start-Sleep -Milliseconds 30; [U32]::mouse_event(0x04,0,0,0,0)
  $did='physical-click'
}
Write-Output ("OK:"+$did+":"+$target.Current.Name)`;
  const out = await runPwsh(script, { AYUS_UI_NAME: String(name), AYUS_UI_TYPE: type ? String(type) : "" });
  if (out === "NOTFOUND" || out.endsWith("NOTFOUND")) {
    return { ok: false, error: `No clickable element matching "${name}". Call ui_list first to see exact names.` };
  }
  const m = /OK:([^:]+):([\s\S]*)$/.exec(out);
  return m
    ? { ok: true, result: `Clicked "${m[2].trim()}" (${m[1]})` }
    : { ok: false, error: out.slice(0, 500) || "click failed" };
}

/**
 * Type text. If `into` names an edit box, sets its value via ValuePattern;
 * otherwise types into whatever currently has focus.
 */
export async function uiType({ text, into } = {}) {
  if (text == null) return { ok: false, error: "text required" };
  const script = `${PREAMBLE}
$text=$env:AYUS_UI_TEXT
$into=$env:AYUS_UI_INTO
$el=$null
if($into){
  $win=Get-Foreground
  $all=$win.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  for($i=0;$i -lt $all.Count;$i++){
    try { $e=$all.Item($i); $c=$e.Current
      if($c.IsEnabled -and -not $c.IsOffscreen -and $c.Name -like "*$into*"){ $el=$e; break } } catch {}
  }
  if(-not $el){ Write-Output 'NOTFOUND'; exit }
} else {
  $el=$AE::FocusedElement
}
$vp=$null
if($el -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$vp) -and -not $vp.Current.IsReadOnly){
  try { $el.SetFocus() } catch {}
  $vp.SetValue($text)
  Write-Output ("OK:value:"+$el.Current.Name)
} else {
  if($el){ try { $el.SetFocus() } catch {} }
  $esc=[regex]::Replace($text,'[+^%~(){}\\[\\]]','{$0}')
  [System.Windows.Forms.SendKeys]::SendWait($esc)
  Write-Output 'OK:keys:focused'
}`;
  const out = await runPwsh(script, { AYUS_UI_TEXT: String(text), AYUS_UI_INTO: into ? String(into) : "" });
  if (out === "NOTFOUND") return { ok: false, error: `No edit box matching "${into}". Call ui_list first.` };
  const m = /OK:([^:]+):([\s\S]*)$/.exec(out);
  return m ? { ok: true, result: `Typed into "${m[2].trim()}" (${m[1]})` } : { ok: false, error: out.slice(0, 500) || "type failed" };
}

/** Send raw keys/shortcuts using .NET SendKeys syntax, e.g. "{ENTER}", "^s", "%{F4}". */
export async function uiKey({ keys } = {}) {
  if (!keys || !String(keys).trim()) return { ok: false, error: "keys required" };
  const script = `${PREAMBLE}
[System.Windows.Forms.SendKeys]::SendWait($env:AYUS_UI_KEYS)
Write-Output 'OK'`;
  await runPwsh(script, { AYUS_UI_KEYS: String(keys) });
  return { ok: true, result: `Sent keys: ${keys}` };
}

export const UI_CONTROL_TOOLS = [
  {
    name: "ui_list",
    description:
      "List the clickable/typeable elements (buttons, menu items, links, text fields…) currently visible in the FOREGROUND window, by their real names. ALWAYS call this first before ui_click/ui_type so you use exact element names. Returns 'ControlType: Name' per line.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "ui_click",
    description:
      "Click a UI element in the foreground window by its name (partial, case-insensitive match), like a human clicking it. Get exact names from ui_list first. Optionally narrow by control type (e.g. 'Button').",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Element name to click, e.g. 'Play', 'Send', 'Sign in'" },
        type: { type: "string", description: "Optional control type filter, e.g. 'Button', 'MenuItem', 'Hyperlink'" },
      },
      required: ["name"],
    },
  },
  {
    name: "ui_type",
    description:
      "Type text into the foreground window. Give `into` (a text field's name from ui_list) to target it directly, or omit it to type into whatever currently has focus.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to type" },
        into: { type: "string", description: "Optional: name of the text field to type into" },
      },
      required: ["text"],
    },
  },
  {
    name: "ui_key",
    description:
      "Press keyboard keys/shortcuts using .NET SendKeys syntax. Examples: '{ENTER}' to submit, '^s' for Ctrl+S, '^a' select all, '{TAB}', '%{F4}' Alt+F4. Use after ui_type to confirm, or to drive the keyboard directly.",
    parameters: {
      type: "object",
      properties: { keys: { type: "string", description: "SendKeys string, e.g. '{ENTER}' or '^s'" } },
      required: ["keys"],
    },
  },
];

export const UI_CONTROL_HANDLERS = {
  ui_list: uiList,
  ui_click: uiClick,
  ui_type: uiType,
  ui_key: uiKey,
};

// Runnable check: `node src/lib/ui-automation.js` lists the foreground window's
// elements. Needs a real desktop — asserts the call returns an ok result shape.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  uiList().then((r) => {
    if (!r || typeof r.ok !== "boolean") throw new Error("uiList did not return an ok-shaped result");
    console.log(r.ok ? r.result : `ERROR: ${r.error}`);
  });
}
