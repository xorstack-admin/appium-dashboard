#!/usr/bin/env python3
"""
save_report.py — Save an Appium Studio HTML report with env, platform, and version tag.

Usage:
    python3 scripts/save_report.py --env staging --platform ios --version v3.4.6 --report report.html
    python3 scripts/save_report.py --env production --platform android --version v2.1.0 --report reports/
    python3 scripts/save_report.py --env staging --platform ios --version "Payments-flow" --report report.html --no-push

Required:
    --env        staging | production
    --platform   ios | android
    --version    Any label: v3.4.6, Sprint-15, Payments-test, etc.
    --report     Path to HTML report file, or folder of HTML files

Optional:
    --label      Human-readable label (defaults to --version)
    --push       Git commit + push to GitHub (default: True)
    --no-push    Skip git push
"""
import argparse, json, os, re, sys, glob, subprocess
from datetime import datetime, timezone

STEP_PATTERN = re.compile(
    r'<h3 class="page-header">(.*?)</h3>\s*'
    r'(?:<div class="alert alert-danger"[^>]*>.*?</div>)?\s*.*?'
    r'<div class="panel panel-(success|danger)">\s*'
    r'<div class="panel-heading">\s*<span[^>]*></span>(Passed|Failed)\s*</div>'
    r'.*?Total Time:\s*([\d.]+)\s*Seconds',
    re.DOTALL,
)
SUB_RE = re.compile(r"^(\d+\.?\s*)(.+)$")

VALID_ENVS      = ['staging', 'production']
VALID_PLATFORMS = ['ios', 'android']


def parse_html(filepath):
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()
    title = re.search(r'<title>(.*?)</title>', content)
    main_name = title.group(1).strip().replace('&amp;','&') if title else ''
    if not main_name or main_name.lower() in ('untitled', 'summary report'):
        main_name = os.path.splitext(os.path.basename(filepath))[0]

    run_started = total_time = device = ''
    m = re.search(r'Run Started.*?<td>(.*?)</td>', content, re.DOTALL)
    if m: run_started = m.group(1).strip()
    m = re.search(r'Total Time.*?<td>(.*?)</td>', content, re.DOTALL)
    if m: total_time = m.group(1).strip()
    m = re.search(r'Device Information.*?<small>\((.*?)\)</small>', content, re.DOTALL)
    if m: device = m.group(1).strip()

    overall = 'Failed' if re.search(r'alert-danger.*?Failed', content, re.DOTALL) else 'Passed'
    all_steps = []
    for i, sm in enumerate(STEP_PATTERN.finditer(content), 1):
        all_steps.append({'step': i, 'name': sm.group(1).strip(),
                          'status': sm.group(3).strip(), 'time': float(sm.group(4))})

    sub_scenarios, current_sub = [], None
    for s in all_steps:
        if re.match(r"^Send text '(\d+\.?\s*.+)'$", s['name']):
            raw = re.match(r"^Send text '(\d+\.?\s*.+)'$", s['name']).group(1)
            if current_sub: sub_scenarios.append(current_sub)
            current_sub = {'name': raw.replace('&amp;','&').strip(), 'steps': []}
        if current_sub: current_sub['steps'].append(s)
    if current_sub: sub_scenarios.append(current_sub)

    subs = []
    for sub in sub_scenarios:
        steps = sub['steps']
        failed = [s for s in steps if s['status'] == 'Failed']
        passed = [s for s in steps if s['status'] == 'Passed']
        slow   = [s for s in steps if s['time'] > 4]
        subs.append({'name': sub['name'], 'totalSteps': len(steps),
                     'passedSteps': len(passed), 'failedSteps': len(failed),
                     'slowSteps': len(slow), 'overall': 'Failed' if failed else 'Passed',
                     'failed': failed, 'slow': slow})

    return {
        'scenario': main_name, 'device': device, 'runStarted': run_started,
        'totalTime': total_time, 'overall': overall,
        'totalSteps':  sum(s['totalSteps']  for s in subs),
        'passedSteps': sum(s['passedSteps'] for s in subs),
        'failedSteps': sum(s['failedSteps'] for s in subs),
        'slowSteps':   sum(s['slowSteps']   for s in subs),
        'subScenarios': subs,
    }


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git_run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0: raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--env',      required=True, choices=VALID_ENVS)
    parser.add_argument('--platform', required=True, choices=VALID_PLATFORMS)
    parser.add_argument('--version',  help='Version label (e.g. v3.4.6 or Payments-test). Falls back to BUILD_VERSION env var.')
    parser.add_argument('--report',   required=True)
    parser.add_argument('--label',    default=None)
    parser.add_argument('--push',     dest='push', action='store_true',  default=True)
    parser.add_argument('--no-push',  dest='push', action='store_false')
    args = parser.parse_args()

    version = args.version or os.environ.get('BUILD_VERSION') or os.environ.get('BUILD_NUMBER')
    if not version:
        print('❌  --version is required (or set BUILD_VERSION env var).')
        sys.exit(1)

    version = version.strip().replace(' ', '-')
    label   = args.label or version
    root    = repo_root()
    target  = os.path.join(root, 'reports', args.env, args.platform, version)
    os.makedirs(target, exist_ok=True)

    # Resolve report files
    report_path = os.path.abspath(args.report)
    if not os.path.exists(report_path):
        print(f'❌  Report path not found: {report_path}'); sys.exit(1)

    reports_data = []
    if os.path.isdir(report_path):
        html_files = sorted(glob.glob(os.path.join(report_path, '*.html')))
        if html_files:
            for f in html_files:
                print(f'  Parsing: {os.path.basename(f)}')
                reports_data.append(parse_html(f))
        else:
            dj = os.path.join(report_path, 'data.json')
            if os.path.exists(dj):
                raw = json.load(open(dj))
                reports_data = raw if isinstance(raw, list) else [raw]
    elif report_path.endswith('.html'):
        print(f'  Parsing: {os.path.basename(report_path)}')
        reports_data.append(parse_html(report_path))
    elif report_path.endswith('.json'):
        raw = json.load(open(report_path))
        reports_data = raw if isinstance(raw, list) else [raw]
    else:
        print(f'❌  Unsupported file type.'); sys.exit(1)

    if not reports_data: print('❌  No data found.'); sys.exit(1)

    # Save data.json
    with open(os.path.join(target, 'data.json'), 'w') as f:
        json.dump(reports_data, f, indent=2)

    # Save meta.json
    all_subs = [s for r in reports_data for s in r.get('subScenarios', [])]
    now = datetime.now(timezone.utc)
    passed = sum(1 for s in all_subs if s.get('overall') == 'Passed')
    failed = sum(1 for s in all_subs if s.get('overall') == 'Failed')
    total  = len(all_subs)
    meta = {
        'version': version, 'label': label, 'env': args.env, 'platform': args.platform,
        'savedAt': now.isoformat(), 'runDate': now.strftime('%Y-%m-%d'),
        'totalSteps': sum(r.get('totalSteps', 0) for r in reports_data),
        'passed': passed, 'failed': failed, 'scenarios': len(reports_data),
        'passRate': round((passed/total)*100, 1) if total > 0 else None,
    }
    with open(os.path.join(target, 'meta.json'), 'w') as f:
        json.dump(meta, f, indent=2)

    print(f'\n✅  Saved: {args.env}/{args.platform}/{version}')
    print(f'   Scenarios : {meta["scenarios"]}  |  Sub-scenarios: {total}')
    print(f'   Passed    : {passed}  |  Failed: {failed}  |  Pass rate: {meta["passRate"]}%')
    print(f'   Location  : {target}')

    if args.push:
        print('\n📤  Committing and pushing…')
        try:
            git_run(['git', 'add', f'reports/{args.env}/{args.platform}/{version}/'], cwd=root)
            msg = f'test-report({args.env}/{args.platform}): {version} — {passed} passed, {failed} failed'
            git_run(['git', 'commit', '-m', msg], cwd=root)
            git_run(['git', 'push'], cwd=root)
            print(f'✅  Pushed: "{msg}"')
        except RuntimeError as e:
            print(f'⚠️   Git push failed (saved locally): {e}')
    else:
        print('\nℹ️   Skipped git push (--no-push).')


if __name__ == '__main__':
    main()
