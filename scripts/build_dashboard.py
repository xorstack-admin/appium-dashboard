#!/usr/bin/env python3
"""
build_dashboard.py — Parse Appium Studio HTML reports and output data.json.

Usage:
    python3 scripts/build_dashboard.py <report.html>
    python3 scripts/build_dashboard.py <folder_of_html_reports/>
    python3 scripts/build_dashboard.py <report.html> --out path/to/data.json

This script ONLY parses and outputs data.json.
To save + version + push to GitHub, pipe the output into save_report.py:

    python3 scripts/build_dashboard.py report.html --out /tmp/data.json
    python3 scripts/save_report.py --version v1.2.0 --report /tmp/data.json
"""

import re
import json
import sys
import os
import glob
import argparse

STEP_PATTERN = re.compile(
    r'<h3 class="page-header">(.*?)</h3>\s*'
    r'(?:<div class="alert alert-danger"[^>]*>.*?</div>)?\s*.*?'
    r'<div class="panel panel-(success|danger)">\s*'
    r'<div class="panel-heading">\s*<span[^>]*></span>(Passed|Failed)\s*</div>'
    r'.*?Total Time:\s*([\d.]+)\s*Seconds',
    re.DOTALL,
)
SUB_SCENARIO_RE = re.compile(r"^Send text '(\d+\.?\s*.+)'$")


def parse_report(filepath: str) -> dict:
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    title_match = re.search(r'<title>(.*?)</title>', content)
    main_name = title_match.group(1).strip() if title_match else ""
    main_name = main_name.replace('&amp;', '&')
    if not main_name or main_name.lower() == 'untitled':
        main_name = os.path.splitext(os.path.basename(filepath))[0]

    run_started = total_time = device = ""
    m = re.search(r'Run Started.*?<td>(.*?)</td>', content, re.DOTALL)
    if m: run_started = m.group(1).strip()
    m = re.search(r'Total Time.*?<td>(.*?)</td>', content, re.DOTALL)
    if m: total_time = m.group(1).strip()
    m = re.search(r'Device Information.*?<small>\((.*?)\)</small>', content, re.DOTALL)
    if m: device = m.group(1).strip()

    overall = "Failed" if re.search(r'alert-danger.*?Failed', content, re.DOTALL) else "Passed"

    all_steps = []
    for i, sm in enumerate(STEP_PATTERN.finditer(content), 1):
        all_steps.append({
            "step"  : i,
            "name"  : sm.group(1).strip(),
            "status": sm.group(3).strip(),
            "time"  : float(sm.group(4)),
        })

    sub_scenarios, current_sub = [], None
    for s in all_steps:
        match = SUB_SCENARIO_RE.match(s["name"])
        if match:
            if current_sub:
                sub_scenarios.append(current_sub)
            current_sub = {"name": match.group(1).replace('&amp;', '&').strip(), "steps": []}
        if current_sub:
            current_sub["steps"].append(s)
    if current_sub:
        sub_scenarios.append(current_sub)

    subs = []
    for sub in sub_scenarios:
        steps  = sub["steps"]
        failed = [s for s in steps if s["status"] == "Failed"]
        passed = [s for s in steps if s["status"] == "Passed"]
        slow   = [s for s in steps if s["time"] > 4]
        subs.append({
            "name"        : sub["name"],
            "totalSteps"  : len(steps),
            "passedSteps" : len(passed),
            "failedSteps" : len(failed),
            "slowSteps"   : len(slow),
            "overall"     : "Failed" if failed else "Passed",
            "failed"      : failed,
            "slow"        : slow,
        })

    return {
        "scenario"    : main_name,
        "device"      : device,
        "runStarted"  : run_started,
        "totalTime"   : total_time,
        "overall"     : overall,
        "totalSteps"  : sum(s["totalSteps"]  for s in subs),
        "passedSteps" : sum(s["passedSteps"] for s in subs),
        "failedSteps" : sum(s["failedSteps"] for s in subs),
        "slowSteps"   : sum(s["slowSteps"]   for s in subs),
        "subScenarios": subs,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?", help="HTML file or folder of HTML files")
    parser.add_argument("--out", default=None, help="Output path for data.json (default: ./data.json)")
    args = parser.parse_args()

    target = args.input
    if not target:
        parser.print_help()
        sys.exit(1)

    html_files = []
    if os.path.isdir(target):
        html_files = sorted(glob.glob(os.path.join(target, "*.html")))
    else:
        html_files = [target]

    if not html_files:
        print("No HTML files found.")
        sys.exit(1)

    reports = []
    for f in html_files:
        print(f"Parsing: {os.path.basename(f)}")
        reports.append(parse_report(f))

    out_path = args.out or os.path.join(os.path.dirname(os.path.abspath(target)), "data.json")
    with open(out_path, "w") as f:
        json.dump(reports, f, indent=2)

    total_subs   = sum(len(r["subScenarios"]) for r in reports)
    passed_subs  = sum(1 for r in reports for s in r["subScenarios"] if s["overall"] == "Passed")
    failed_subs  = sum(1 for r in reports for s in r["subScenarios"] if s["overall"] == "Failed")

    print(f"\ndata.json written to: {out_path}")
    print(f"  {len(reports)} scenario(s) | {total_subs} sub-scenarios | {passed_subs} passed | {failed_subs} failed")
    print(f"\nNext step — save with version tag:")
    print(f"  python3 scripts/save_report.py --version v1.0.0 --report {out_path}")


if __name__ == "__main__":
    main()
