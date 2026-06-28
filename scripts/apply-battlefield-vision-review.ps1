$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$state = Join-Path $root "data-battlefield"
$project = Get-Content (Join-Path $state "active-project.txt")
$candidates = Get-Content (Join-Path $state "vision-review\candidates.json") -Raw | ConvertFrom-Json

$approved = @{
  1=@("vehicle","wide","urban",72,82,82,30,95); 4=@("vehicle","medium","industrial",96,98,86,30,96);
  6=@("character","medium","industrial",93,96,86,24,94); 7=@("vehicle","wide","mountain",76,84,82,28,84);
  8=@("vehicle","wide","mountain",75,88,92,20,92); 9=@("vehicle","wide","forest",72,80,82,30,82);
  10=@("aircraft","wide","urban",82,91,88,18,90); 13=@("character","wide","suburban",60,68,86,20,84);
  14=@("vehicle","wide","suburban",78,82,88,26,86); 15=@("vehicle","wide","industrial",76,92,90,24,94);
  17=@("vehicle","wide","mountain",70,84,92,18,90); 19=@("vehicle","wide","industrial",82,93,86,24,94);
  20=@("aircraft","wide","sky",88,99,98,8,99); 22=@("vehicle","wide","suburban",68,86,96,12,92);
  23=@("vehicle","medium","urban",94,96,84,26,91); 27=@("aircraft","wide","suburban",94,98,82,20,96);
  28=@("vehicle","wide","suburban",74,82,84,28,84); 30=@("aircraft","long","sky",68,90,90,18,92);
  31=@("vehicle","wide","industrial",66,78,84,30,82); 32=@("character","close","industrial",82,86,90,12,88);
  33=@("vehicle","wide","industrial",80,90,86,28,90); 34=@("vehicle","wide","urban",86,94,88,24,94);
  35=@("environment","wide","urban",58,82,94,12,91); 38=@("aircraft","long","sky",88,96,86,20,96);
  40=@("character","medium","interior",76,80,88,18,87); 41=@("environment","wide","industrial",55,78,92,16,89);
  42=@("environment","wide","mountain",62,94,98,8,96); 45=@("character","wide","desert",74,88,94,10,92);
  50=@("vehicle","wide","suburban",72,84,82,28,85); 51=@("aircraft","wide","urban",88,99,96,12,98);
  52=@("vehicle","wide","urban",76,86,84,28,86); 54=@("character","wide","industrial",96,99,92,14,99);
  57=@("aircraft","wide","forest",90,98,94,12,97); 59=@("vehicle","wide","industrial",80,90,88,24,88)
}

$reviews = foreach ($candidate in $candidates) {
  $decision = $approved[[int]$candidate.reviewIndex]
  if ($decision) {
    @{
      fileId = $candidate.id
      approved = $true
      score = $decision[7]
      traits = @{
        subject=$decision[0]; shotScale=$decision[1]; environment=$decision[2]
        intensity=$decision[3]; spectacle=$decision[4]; clarity=$decision[5]; obstruction=$decision[6]
      }
      reason = "Vision-approved game trailer shot with readable action, scale, and composition."
    }
  } else {
    @{
      fileId = $candidate.id
      approved = $false
      score = 20
      traits = @{subject="unknown";shotScale="medium";environment="unknown";intensity=30;spectacle=20;clarity=25;obstruction=80}
      reason = "Rejected by vision review: generic HUD, low readability, menu, damage state, or weak trailer composition."
    }
  }
}

$body = @{ reviews = $reviews } | ConvertTo-Json -Depth 5
$updated = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4314/api/projects/$project/vision-review" -ContentType "application/json" -Body $body
$updated | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $state "vision-reviewed-project.json")
