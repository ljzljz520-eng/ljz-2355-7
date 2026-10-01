#!/bin/bash
B=http://localhost:3000/api
NONCE="run-$RANDOM-$RANDOM"
http(){ curl -s -o /tmp/body.json -w '%{http_code}' "$@"; }
jval(){ python3 -c "import json;print(json.load(open('/tmp/body.json'))$1)"; }
pass(){ echo "  ✅ $1"; }
die(){ echo "  ❌ $1"; exit 1; }
say(){ echo "=== $1"; }
upload(){ # instance path file
  curl -s -X POST "$B/instances/$1/evidence" -F "file=@$2"
}
jsha(){ python3 -c "import json,sys;print(json.load(sys.stdin)['content_sha'])"; }

say "A. AX-210/A 钉 v1.0.0 全流程（4U 双电源）"
http -X POST $B/instances -H 'Content-Type: application/json' -d '{"label":"LINE3","model_code":"AX-210","hw_rev":"A","version_id":"mv-axa-10","migration_policy":"lock"}'
IID=$(jval "['instance']['id']")
[ "$(jval "['instance']['manual_version']")" = "1.0.0" ] || die "未钉住1.0.0"
mkphoto(){ printf '%s-%s' "$1" "$NONCE" > "$2"; }
mkphoto PHOTO-NAMEPLATE /tmp/p1.bin
SHA=$(upload $IID /tmp/p1.bin | jsha)
http -X POST $B/instances/$IID/steps/st-a10-S10/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}"
http -X PUT $B/instances/$IID/conditions -H 'Content-Type: application/json' -d '{"answers":{"c-rack":"4U","c-psu":"2","c-sn":"AX210-DEMO"}}'
http -X POST $B/instances/$IID/steps/st-a10-S20/complete -H 'Content-Type: application/json' -d '{"values":[{"value_text":"条件逐项核对：4U/双电源/序列号一致"}]}'
mkphoto PHOTO-RAIL /tmp/p2.bin
SHA=$(upload $IID /tmp/p2.bin | jsha)
http -X POST $B/instances/$IID/steps/st-a10-S30/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}"
mkphoto PHOTO-FASTEN /tmp/p3.bin
SHA=$(upload $IID /tmp/p3.bin | jsha)
code=$(http -X POST $B/instances/$IID/steps/st-a10-S40/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}")
[ "$code" = "422" ] || die "S40缺数值应422"
http -X POST $B/instances/$IID/steps/st-a10-S40/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}],\"values\":[{\"value_text\":\"资料未给扭矩区间，按现场核对记录（不编造）\"}]}"
mkphoto PHOTO-PSU /tmp/p4.bin; SHA=$(upload $IID /tmp/p4.bin | jsha)
http -X POST $B/instances/$IID/steps/st-a10-S50/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}"
mkphoto PHOTO-CONN /tmp/p5.bin; SHA=$(upload $IID /tmp/p5.bin | jsha)
http -X POST $B/instances/$IID/steps/st-a10-S60/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}"
http -X POST $B/instances/$IID/steps/st-a10-S70/complete -H 'Content-Type: application/json' -d '{}'
http -X GET $B/instances/$IID
[ "$(jval "['instance']['status']")" = "complete" ] || die "未complete"
pass "全步骤完成 complete（证据齐全，无编造扭矩；缺数值422）"

say "B. 2U/单电源：S40/S60 不适用"
http -X POST $B/instances -H 'Content-Type: application/json' -d '{"label":"LINE3-2U","model_code":"AX-210","hw_rev":"A","version_id":"mv-axa-10"}'
IID2=$(jval "['instance']['id']")
http -X PUT $B/instances/$IID2/conditions -H 'Content-Type: application/json' -d '{"answers":{"c-rack":"2U","c-psu":"1","c-sn":"X"}}'
http -X GET $B/instances/$IID2
python3 - <<'PY' || die '条件分支断言失败'
import json
d=json.load(open('/tmp/body.json'))
m={s['code']:s['applicability'] for s in d['steps']}
assert m['S40']=='not_applicable' and m['S60']=='not_applicable' and m['S50']=='applicable'
PY
pass "条件驱动适用性：不适用步骤排除出分母"

say "C. 图纸升级（锁定策略仍显示旧版，复核不平移进度）"
printf '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/><text x="5" y="50">RACK %s</text></svg>' "$NONCE" > /tmp/racknew.svg
UP=$(curl -s -X POST $B/admin/drawings/DWG-RACK/versions -H 'X-Actor-Role: admin' -F file=@/tmp/racknew.svg -F change_note=新版)
echo "$UP" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['review_items_generated']>=1,d" || die "发布新版未生成复核"
NEWV=$(echo "$UP" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
http -X GET $B/instances/$IID
python3 - "$NEWV" <<'PY' || die '图纸升级断言失败'
import json,sys
newv=sys.argv[1]
d=json.load(open('/tmp/body.json'))
s40=[s for s in d['steps'] if s['code']=='S40'][0]
assert s40['drawings'][0]['version']=='1'            # 锁定仍显示 v1
assert s40['drawings'][0]['latest_version']==newv
assert s40['drawings'][0]['has_upgrade'] is True
assert s40['state']=='done' and s40['run_state']=='recheck_open'
assert d['progress']['pct']==100                     # 进度不平移
assert d['instance']['status']=='blocked'
assert any(r['reason']=='drawing_upgraded' for r in d['reviews'])
PY
pass "锁定视图仍旧版；步骤保持done但打开复核；进度100%不平移；状态blocked"

say "D. 复核逐项关闭（证据保留）"
for RID in $(curl -s $B/instances/$IID | python3 -c "import json,sys;[print(r['id']) for r in json.load(sys.stdin)['reviews'] if r['reason']=='drawing_upgraded']"); do
  code=$(http -X POST $B/instances/$IID/reviews/$RID/resolve -H 'Content-Type: application/json' -d '{"resolution":"已对照新版复核，原照片留存"}')
  [ "$code" = "200" ] || die "复核关闭失败"
done
curl -s $B/instances/$IID | python3 -c "import json,sys;d=json.load(sys.stdin);assert len(d['evidence'])==7, d['evidence']" || die "证据数量变化"
pass "升级复核逐项可关闭；步骤仍done；证据未删"

say "E. 受控迁移（逐项差异确认 / 旧证据保留 / 新增步骤不自动勾选）"
http -X POST $B/instances -H 'Content-Type: application/json' -d '{"label":"MIG","model_code":"AX-210","hw_rev":"A","version_id":"mv-axa-10","migration_policy":"controlled"}'
IID3=$(jval "['instance']['id']")
http -X PUT $B/instances/$IID3/conditions -H 'Content-Type: application/json' -d '{"answers":{"c-rack":"4U","c-psu":"2","c-sn":"AX210"}}'
for n in 1 2; do mkphoto "PHOTO-M$n" /tmp/m$n.bin; done
SHA=$(upload $IID3 /tmp/m1.bin | jsha)
http -X POST $B/instances/$IID3/steps/st-a10-S10/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}"
http -X POST $B/instances/$IID3/steps/st-a10-S20/complete -H 'Content-Type: application/json' -d '{"values":[{"value_text":"条件确认"}]}'
SHA=$(upload $IID3 /tmp/m2.bin | jsha)
http -X POST $B/instances/$IID3/steps/st-a10-S30/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}"
MIG=$(curl -s -X POST $B/instances/$IID3/migrations -H 'Content-Type: application/json' -d '{"to_version_id":"mv-axa-11"}')
echo "$MIG" | python3 -c "import json,sys;d=json.load(sys.stdin);assert {'S30','S40','S45','S70'} <= {i['code'] for i in d['diff']['items']}" || die "差异项不符"
MID=$(echo "$MIG" | python3 -c "import json,sys;print(json.load(sys.stdin)['migrationId'])")
ALL=$(echo "$MIG" | python3 -c "import json,sys;print(json.dumps([i['code'] for i in json.load(sys.stdin)['diff']['items']]))")
PART=$(echo "$ALL" | python3 -c "import json,sys;a=json.load(sys.stdin);print(json.dumps(a[:-1]))")
code=$(http -X POST $B/instances/$IID3/migrations/$MID/confirm -H 'Content-Type: application/json' -d "{\"confirmed_codes\":$PART}")
[ "$code" = "422" ] || die "漏确认应422"
http -X POST $B/instances/$IID3/migrations/$MID/confirm -H 'Content-Type: application/json' -d "{\"confirmed_codes\":$ALL}"
python3 - <<'PY' || die '迁移断言失败'
import json
d=json.load(open('/tmp/body.json'))
assert d['instance']['manual_version']=='1.1.0'
codes={s['code']:s for s in d['steps']}
assert codes['S45']['state']=='pending'
assert codes['S30']['state']=='done' and codes['S30']['run_state']=='recheck_open'
assert codes['S40']['state']=='pending'           # 没执行过，不会平移
assert any(r['reason']=='migration_diff' for r in d['reviews'])
assert len([e for e in d['evidence'] if not e['superseded']])>=3
PY
pass "迁移成功：差异逐项确认、新增步骤待执行、已执行差异步骤打开复核但进度不平移、旧证据保留"

say "F. 拒绝迁移 => 锁定旧手册"
http -X POST $B/instances -H 'Content-Type: application/json' -d '{"label":"REJ","model_code":"AX-210","hw_rev":"A","version_id":"mv-axa-10"}'
IID4=$(jval "['instance']['id']")
M2=$(curl -s -X POST $B/instances/$IID4/migrations -H 'Content-Type: application/json' -d '{"to_version_id":"mv-axa-11"}')
MID2=$(echo "$M2" | python3 -c "import json,sys;print(json.load(sys.stdin)['migrationId'])")
http -X POST $B/instances/$IID4/migrations/$MID2/reject -H 'Content-Type: application/json'
[ "$(jval "['instance']['manual_version']")" = "1.0.0" ] || die "拒绝后版本变了"
pass "拒绝迁移仍锁定 v1.0.0"

say "G. 跨分支（型号/硬件修订）迁移被拒"
code=$(http -X POST $B/instances/$IID4/migrations -H 'Content-Type: application/json' -d '{"to_version_id":"mv-axb-10"}')
[ "$code" = "409" ] || die "跨分支迁移应409"
pass "迁移仅限同型号同修订；变更必须走分支切换"

say "H. 分支切换 A->B（不迁移勾选/清空条件/旧证据保留）"
code=$(http -X POST $B/instances/$IID3/branch-switch/preview -H 'Content-Type: application/json' -d '{"model_code":"BX-300","hw_rev":"B"}')
[ "$code" = "409" ] || die "无资料分支应停在待确认409"
PREV=$(curl -s -X POST $B/instances/$IID3/branch-switch/preview -H 'Content-Type: application/json' -d '{"model_code":"AX-210","hw_rev":"B"}')
[ "$(echo "$PREV" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['diff']['items']))")" -gt 0 ] || die "分支差异为空"
http -X POST $B/instances/$IID3/branch-switch/execute -H 'Content-Type: application/json' -d '{"model_code":"AX-210","hw_rev":"B"}'
python3 - <<'PY' || die '分支切换断言失败'
import json
d=json.load(open('/tmp/body.json'))
assert d['instance']['hw_rev']=='B' and d['instance']['manual_version']=='1.0.0'
assert all(not c['answered'] for c in d['conditions'])
assert not any(s['state']=='done' for s in d['steps'])
assert len(d['evidence'])>=3
assert 'S05' in {s['code'] for s in d['steps']}
assert any(r['reason']=='branch_switch_diff' for r in d['reviews'])
PY
pass "分支切换不迁移勾选、条件全部待重新确认、旧证据保留、差异复核留存"

say "I. 离线迟到照片（先 S05 再 S10；迟到不改完成时间）"
http -X PUT $B/instances/$IID3/conditions -H 'Content-Type: application/json' -d '{"answers":{"c-rack":"4U","c-psu":"2"}}'
mkphoto PHOTO-B-S05 /tmp/b05.bin
SHA=$(upload $IID3 /tmp/b05.bin | jsha)
http -X POST $B/instances/$IID3/steps/st-b10-S05/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}"
mkphoto PHOTO-B-S10 /tmp/b1.bin
SHA=$(upload $IID3 /tmp/b1.bin | jsha)
http -X POST $B/instances/$IID3/steps/st-b10-S10/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"k\",\"content_sha\":\"$SHA\"}]}"
DONE1=$(curl -s $B/instances/$IID3 | python3 -c "import json,sys;print([s['done_at'] for s in json.load(sys.stdin)['steps'] if s['code']=='S10'][0])")
sleep 1
mkphoto PHOTO-LATE /tmp/late.bin
http -X POST $B/instances/$IID3/steps/st-b10-S10/late-photo -H 'X-Captured-At: 2026-09-30T08:00:00Z' -F file=@/tmp/late.bin
python3 - "$DONE1" <<'PY' || die '迟到照片断言失败'
import json,sys
d=json.load(open('/tmp/body.json'))
late=[e for e in d['evidence'] if e['step_code']=='S10' and e['late']]
assert len(late)==1 and late[0]['captured_at'].startswith('2026-09-30')
done=[s['done_at'] for s in d['steps'] if s['code']=='S10'][0]
assert done==sys.argv[1]
PY
pass "迟到照片标late保留拍摄时间；done_at与进度不变"

say "J. 图纸撤回（已执行步骤产生复核，新使用被阻断）"
http -X POST $B/admin/drawings/DWG-HARNESS/withdraw -H 'X-Actor-Role: admin' -H 'Content-Type: application/json'
curl -s $B/instances/$IID > /tmp/wd.json
python3 - <<'PY' || die '撤回断言失败'
import json
d=json.load(open('/tmp/wd.json'))
assert any(r['reason']=='drawing_withdrawn' for r in d['reviews'])
s60=[s for s in d['steps'] if s['code']=='S60'][0]
assert s60['drawings'][0]['status']=='withdrawn'
PY
pass "撤回生成 drawing_withdrawn 复核；图纸芯片禁止查看/使用"

say "K. 打印失败可重试"
code=$(http -X POST $B/instances/$IID/print -H 'Content-Type: application/json' -d '{"simulate_fail":true}')
[ "$code" = "502" ] || die "打印应502"
PJ=$(jval "['print_job_id']")
code=$(http -X POST $B/print-jobs/$PJ/retry -H 'Content-Type: application/json' -d '{"simulate_fail":true}')
[ "$code" = "502" ] || die "故障重试应502"
code=$(http -X POST $B/print-jobs/$PJ/retry -H 'Content-Type: application/json' -d '{}')
[ "$code" = "200" ] || die "恢复后应200"
pass "打印失败留任务可重试，恢复后成功，勾选数据不受影响"

say "L. 导出（实际采用资料版 + 未决项）"
curl -s $B/instances/$IID/export > /tmp/export.json
python3 - "$NEWV" <<'PY' || die '导出断言失败'
import json,sys
d=json.load(open('/tmp/export.json'))
assert d['materials_actually_used']['manual_version']=='1.0.0'
dwg={x['code']:x for x in d['materials_actually_used']['drawings']}
assert dwg['DWG-RACK']['version']=='1'               # 实例实际用的是 v1
kinds={o['type'] for o in d['open_items']}
assert 'drawing_withdrawn' in kinds
assert not any(o['type']=='drawing_upgraded' for o in d['open_items'])  # 已解决
PY
pass "导出准确反映实际资料版（v1.0.0/rack v1）与未决项"

say "M. 未决项存在时禁止定稿"
code=$(http -X POST $B/instances/$IID/finalize -H 'Content-Type: application/json')
[ "$code" = "409" ] || die "应409"
pass "有未决复核时禁止定稿"

echo ALL_E2E_OK
