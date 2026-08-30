#!/usr/bin/env bash
set -euo pipefail

extract_bin="${DL_EXTRACT_BIN:-/Users/chrishafley/projects/sprefa/v6/sprefa-extract/target/release/extract}"
fixture="${1:-$(dirname "$0")/0_fixture.ts}"

"$extract_bin" \
  --ast-pattern 'react=const [$VALUE, $WRITER] = useState($INIT)' \
  --ast-capture react=VALUE \
  --ast-capture react=WRITER \
  --ast-capture react=INIT \
  --ast-pattern 'react_generic=const [$VALUE, $WRITER] = useState<$TYPE>($INIT)' \
  --ast-capture react_generic=VALUE \
  --ast-capture react_generic=WRITER \
  --ast-capture react_generic=INIT \
  --ast-pattern 'signal=const $OWNER = Signal($INIT)' \
  --ast-capture signal=OWNER \
  --ast-capture signal=INIT \
  --ast-pattern 'subject=const $OWNER = new BehaviorSubject($INIT)' \
  --ast-capture subject=OWNER \
  --ast-capture subject=INIT \
  --ast-pattern 'react_write=$WRITER($NEXT)' \
  --ast-capture react_write=WRITER \
  --ast-pattern 'signal_write=$OWNER.$($NEXT)' \
  --ast-capture signal_write=OWNER \
  --ast-pattern 'subject_write=$OWNER.next($NEXT)' \
  --ast-capture subject_write=OWNER \
  "$fixture"
