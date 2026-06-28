$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$state = Join-Path $root "data-battlefield"
$project = Get-Content (Join-Path $state "active-project.txt")
$draft = Get-Content (Join-Path $state "active-draft.txt")
$music = Get-Content (Join-Path $state "active-music.txt")
$body = @{ assetId = $music } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4314/api/projects/$project/drafts/$draft/render" -ContentType "application/json" -Body $body -TimeoutSec 3600
$result | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $state "render-result.json")
