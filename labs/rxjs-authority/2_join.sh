#!/usr/bin/env bash
set -euo pipefail

lab_dir="$(dirname "$0")"

"$lab_dir/1_extract.sh" "${1:-$lab_dir/0_fixture.ts}" |
  jq -s '
    [
      .[]
      | select(.record == "capture")
      | {
          query,
          capture,
          text,
          start,
          end,
          match_start,
          match_end,
          authority:
            if (.query == "react" or .query == "react_generic") and .capture == "VALUE" then .text
            elif (.query == "signal" or .query == "subject") then
              (.text | sub("(Signal|Subject)$"; ""))
            else null
            end
        }
    ] as $captures
    | {
        captures: $captures,
        authorities: [
          $captures[]
          | select((.query == "react" or .query == "react_generic") and .capture == "VALUE" or .query == "signal" or .query == "subject")
          | { logical_name: .authority, kind: .query, writer: .text, start: .start }
        ],
        duplicate_authorities: [
          $captures
          | map(select((.query == "react" or .query == "react_generic") and .capture == "VALUE" or .query == "signal" or .query == "subject"))
          | group_by(.authority)[]
          | select(length > 1)
          | { logical_name: .[0].authority, kinds: map(.query), writers: map(.text) }
        ]
      }
  '
