# ps-json.ps1 - the JSON reader/writer the PowerShell setup scripts share.
#
# Dot-sourced by claude-redeem.ps1 and device-id.ps1. Not run on its own.
#
# WHY NOT ConvertFrom-Json / ConvertTo-Json. Those cmdlets do not round-trip a
# settings file the way the Node redeem does, and settings.json is a file the
# person owns:
#   - Windows PowerShell 5.1's ConvertTo-Json stops at depth 2 by default and
#     escapes < > & ' as < etc., so a `permissions` block comes back
#     rewritten or truncated.
#   - PowerShell 7's ConvertFrom-Json turns ISO-8601 strings into DateTime.
#   - Neither accepts keys that differ only in case, and 5.1 rejects "".
# This file implements JSON.parse / JSON.stringify(v, null, 2) closely enough
# that the PowerShell redeem writes the same bytes as claude-redeem.mjs
# (tests/unit/plugin/claude-redeem-ps1.test.ts compares them).
#
# Value model: object -> OrderedDictionary (ordinal, case-sensitive keys);
# array -> List[object]; string -> [string]; true/false -> [bool];
# null -> $null; number -> [Tuple[string]] holding the number's source text.
# Numbers are written back as their source text: JSON.stringify would rewrite a
# non-canonical number (1.50 -> 1.5), so that is the one place the two differ.
#
# Windows PowerShell 5.1 syntax only. ASCII only: 5.1 reads a BOM-less script
# in the ANSI code page.

function New-TsJsonObject {
  return ,(New-Object System.Collections.Specialized.OrderedDictionary -ArgumentList ([System.StringComparer]::Ordinal))
}

function New-TsJsonArray {
  return ,(New-Object 'System.Collections.Generic.List[object]')
}

function Test-TsJsonObject($Value) {
  return ($Value -is [System.Collections.Specialized.OrderedDictionary])
}

function Test-TsJsonArray($Value) {
  return ($Value -is [System.Collections.Generic.List[object]])
}

$script:TsJsonNumberRe = New-Object System.Text.RegularExpressions.Regex -ArgumentList '\G-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'
$script:TsJsonPlainRunRe = New-Object System.Text.RegularExpressions.Regex -ArgumentList '\G[^"\\\u0000-\u001f]+'

function Skip-TsJsonWhitespace($St) {
  $s = $St.s
  while ($St.i -lt $s.Length) {
    $c = $s[$St.i]
    if ($c -eq ' ' -or $c -eq "`t" -or $c -eq "`n" -or $c -eq "`r") { $St.i++ } else { break }
  }
}

function Read-TsJsonString($St) {
  $s = $St.s
  # Caller has seen the opening quote.
  $St.i++
  $sb = New-Object System.Text.StringBuilder
  while ($true) {
    # The plain run in one step: ~/.claude.json can be hundreds of KB, and a
    # per-character loop in PowerShell is slow enough to notice.
    $run = $script:TsJsonPlainRunRe.Match($s, $St.i)
    if ($run.Length -gt 0) {
      [void]$sb.Append($run.Value)
      $St.i += $run.Length
    }
    if ($St.i -ge $s.Length) { throw 'json: unterminated string' }
    $c = $s[$St.i]
    if ($c -eq '"') { $St.i++; break }
    if ([int]$c -lt 0x20) { throw "json: control character in string at $($St.i)" }
    if ($c -eq '\') {
      if ($St.i + 1 -ge $s.Length) { throw 'json: unterminated escape' }
      $e = $s[$St.i + 1]
      switch -CaseSensitive ([string]$e) {
        '"' { [void]$sb.Append('"'); $St.i += 2 }
        '\' { [void]$sb.Append('\'); $St.i += 2 }
        '/' { [void]$sb.Append('/'); $St.i += 2 }
        'b' { [void]$sb.Append([char]8); $St.i += 2 }
        'f' { [void]$sb.Append([char]12); $St.i += 2 }
        'n' { [void]$sb.Append([char]10); $St.i += 2 }
        'r' { [void]$sb.Append([char]13); $St.i += 2 }
        't' { [void]$sb.Append([char]9); $St.i += 2 }
        'u' {
          if ($St.i + 6 -gt $s.Length) { throw 'json: bad unicode escape' }
          $hex = $s.Substring($St.i + 2, 4)
          if ($hex -notmatch '^[0-9A-Fa-f]{4}$') { throw 'json: bad unicode escape' }
          [void]$sb.Append([char][Convert]::ToInt32($hex, 16))
          $St.i += 6
        }
        default { throw "json: bad escape at $($St.i)" }
      }
      continue
    }
    [void]$sb.Append($c)
    $St.i++
  }
  return $sb.ToString()
}

function Read-TsJsonValue($St, [int]$Depth) {
  if ($Depth -gt 256) { throw 'json: nested too deeply' }
  Skip-TsJsonWhitespace $St
  $s = $St.s
  if ($St.i -ge $s.Length) { throw 'json: unexpected end of input' }
  $c = $s[$St.i]
  if ($c -eq '{') {
    $St.i++
    $obj = New-TsJsonObject
    Skip-TsJsonWhitespace $St
    if ($St.i -lt $s.Length -and $s[$St.i] -eq '}') { $St.i++; return ,$obj }
    while ($true) {
      Skip-TsJsonWhitespace $St
      if ($St.i -ge $s.Length -or $s[$St.i] -ne '"') { throw "json: expected a key at $($St.i)" }
      $key = Read-TsJsonString $St
      Skip-TsJsonWhitespace $St
      if ($St.i -ge $s.Length -or $s[$St.i] -ne ':') { throw "json: expected ':' at $($St.i)" }
      $St.i++
      $val = Read-TsJsonValue $St ($Depth + 1)
      # JSON.parse: a repeated key keeps its FIRST position and its LAST value.
      $obj[$key] = $val
      Skip-TsJsonWhitespace $St
      if ($St.i -ge $s.Length) { throw 'json: unterminated object' }
      $d = $s[$St.i]
      $St.i++
      if ($d -eq ',') { continue }
      if ($d -eq '}') { break }
      throw "json: expected ',' or '}' at $($St.i - 1)"
    }
    return ,$obj
  }
  if ($c -eq '[') {
    $St.i++
    $arr = New-TsJsonArray
    Skip-TsJsonWhitespace $St
    if ($St.i -lt $s.Length -and $s[$St.i] -eq ']') { $St.i++; return ,$arr }
    while ($true) {
      $val = Read-TsJsonValue $St ($Depth + 1)
      $arr.Add($val)
      Skip-TsJsonWhitespace $St
      if ($St.i -ge $s.Length) { throw 'json: unterminated array' }
      $d = $s[$St.i]
      $St.i++
      if ($d -eq ',') { continue }
      if ($d -eq ']') { break }
      throw "json: expected ',' or ']' at $($St.i - 1)"
    }
    return ,$arr
  }
  if ($c -eq '"') { return (Read-TsJsonString $St) }
  if ($s.Length - $St.i -ge 4 -and $s.Substring($St.i, 4) -ceq 'true') { $St.i += 4; return $true }
  if ($s.Length - $St.i -ge 5 -and $s.Substring($St.i, 5) -ceq 'false') { $St.i += 5; return $false }
  if ($s.Length - $St.i -ge 4 -and $s.Substring($St.i, 4) -ceq 'null') { $St.i += 4; return $null }
  $m = $script:TsJsonNumberRe.Match($s, $St.i)
  if ($m.Success -and $m.Length -gt 0) {
    $St.i += $m.Length
    return ,([System.Tuple]::Create([string]$m.Value))
  }
  throw "json: unexpected character at $($St.i)"
}

# Parse a whole document. Throws (with a position, never the text) on anything
# JSON.parse would refuse, including a leading byte-order mark.
function ConvertFrom-TsJson([string]$Text) {
  $st = @{ s = $Text; i = 0 }
  $v = Read-TsJsonValue $st 0
  Skip-TsJsonWhitespace $st
  if ($st.i -ne $st.s.Length) { throw "json: unexpected trailing input at $($st.i)" }
  return ,$v
}

# JSON.stringify's string escaping: the short escapes, \u00xx for the other
# control characters, and \uXXXX for a lone surrogate. Everything else raw.
function ConvertTo-TsJsonString([string]$Value) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  for ($i = 0; $i -lt $Value.Length; $i++) {
    $c = $Value[$i]
    $n = [int]$c
    if ($c -eq '"') { [void]$sb.Append('\"') }
    elseif ($c -eq '\') { [void]$sb.Append('\\') }
    elseif ($n -eq 8) { [void]$sb.Append('\b') }
    elseif ($n -eq 9) { [void]$sb.Append('\t') }
    elseif ($n -eq 10) { [void]$sb.Append('\n') }
    elseif ($n -eq 12) { [void]$sb.Append('\f') }
    elseif ($n -eq 13) { [void]$sb.Append('\r') }
    elseif ($n -lt 0x20) { [void]$sb.Append('\u' + $n.ToString('x4')) }
    elseif ($n -ge 0xD800 -and $n -le 0xDBFF) {
      if ($i + 1 -lt $Value.Length -and [int]$Value[$i + 1] -ge 0xDC00 -and [int]$Value[$i + 1] -le 0xDFFF) {
        [void]$sb.Append($c)
        [void]$sb.Append($Value[$i + 1])
        $i++
      } else {
        [void]$sb.Append('\u' + $n.ToString('x4'))
      }
    }
    elseif ($n -ge 0xDC00 -and $n -le 0xDFFF) { [void]$sb.Append('\u' + $n.ToString('x4')) }
    else { [void]$sb.Append($c) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

# A JavaScript object lists array-index keys ("0", "17") first, in numeric
# order, then the rest in insertion order. JSON.stringify follows that order.
function Get-TsJsonKeyOrder($Obj) {
  $index = New-Object 'System.Collections.Generic.List[object]'
  $other = New-Object 'System.Collections.Generic.List[string]'
  foreach ($k in @($Obj.get_Keys())) {
    $n = [uint64]0
    if ($k -match '^(0|[1-9][0-9]{0,9})$' -and [uint64]::TryParse($k, [ref]$n) -and $n -lt 4294967295) {
      $index.Add([System.Tuple]::Create($n, [string]$k))
    } else {
      $other.Add([string]$k)
    }
  }
  $sorted = @($index | Sort-Object { $_.Item1 } | ForEach-Object { $_.Item2 })
  return ,(@($sorted) + @($other))
}

# JSON.stringify($Value, null, 2) for the value model above.
function ConvertTo-TsJson($Value, [string]$Indent = '') {
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
  if ($Value -is [string]) { return (ConvertTo-TsJsonString $Value) }
  if ($Value -is [System.Tuple[string]]) { return $Value.Item1 }
  $inner = $Indent + '  '
  if (Test-TsJsonObject $Value) {
    $keys = Get-TsJsonKeyOrder $Value
    if ($keys.Count -eq 0) { return '{}' }
    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($k in $keys) {
      $parts.Add($inner + (ConvertTo-TsJsonString $k) + ': ' + (ConvertTo-TsJson $Value[$k] $inner))
    }
    return "{`n" + ($parts -join ",`n") + "`n" + $Indent + '}'
  }
  if (Test-TsJsonArray $Value) {
    if ($Value.Count -eq 0) { return '[]' }
    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($item in $Value) { $parts.Add($inner + (ConvertTo-TsJson $item $inner)) }
    return "[`n" + ($parts -join ",`n") + "`n" + $Indent + ']'
  }
  throw 'json: value of an unsupported type'
}

# `{ ...value }` in JavaScript: an object's own keys, an array's or a string's
# indexes, nothing for anything else. Returns a new object.
function Copy-TsJsonSpread($Value) {
  $out = New-TsJsonObject
  if (Test-TsJsonObject $Value) {
    foreach ($k in @($Value.get_Keys())) { $out[$k] = $Value[$k] }
  } elseif (Test-TsJsonArray $Value) {
    for ($i = 0; $i -lt $Value.Count; $i++) { $out[[string]$i] = $Value[$i] }
  } elseif ($Value -is [string]) {
    for ($i = 0; $i -lt $Value.Length; $i++) { $out[[string]$i] = [string]$Value[$i] }
  }
  return ,$out
}

# A string member of a parsed object, or '' (absent, null, or not a string).
function Get-TsJsonString($Obj, [string]$Key) {
  if (-not (Test-TsJsonObject $Obj)) { return '' }
  if (-not $Obj.Contains($Key)) { return '' }
  $v = $Obj[$Key]
  if ($v -is [string]) { return $v }
  return ''
}

# A member of a parsed object, or $null.
function Get-TsJsonMember($Obj, [string]$Key) {
  if (-not (Test-TsJsonObject $Obj)) { return $null }
  if (-not $Obj.Contains($Key)) { return $null }
  return ,$Obj[$Key]
}

# Bytes as UTF-8 text, no BOM stripping (JSON.parse refuses a BOM, and so does
# ConvertFrom-TsJson), invalid sequences replaced as Node's 'utf8' does.
function ConvertFrom-TsUtf8([byte[]]$Bytes) {
  return (New-Object System.Text.UTF8Encoding -ArgumentList $false, $false).GetString($Bytes)
}
