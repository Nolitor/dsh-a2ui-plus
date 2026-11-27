"""Update the public npm and GitHub download history and its README chart."""
import argparse
from datetime import date, datetime, timedelta, timezone
from itertools import accumulate
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator, StrMethodFormatter


PACKAGE = "dsh-a2ui"
REPOSITORY = "ChimeSky/dsh-a2ui"
NPM_FIRST_DAY = "2026-11-20"  # First publication, UTC.
NPM_DOWNLOADS = f"https://api.npmjs.org/downloads/range/last-year/{PACKAGE}"
GITHUB_RELEASES = f"https://api.github.com/repos/{REPOSITORY}/releases"
GITHUB_CLONES = f"https://api.github.com/repos/{REPOSITORY}/traffic/clones?per=day"
NPM_COLOR = "#275bd2"
GITHUB_COLOR = "#00796e"
CLONES_COLOR = "#6b37a8"


def fetch_json(url, token=None):
    headers = {"User-Agent": f"{PACKAGE}-download-stats", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urlopen(Request(url, headers=headers), timeout=25) as response:
        return json.load(response)


def npm_counts():
    # Use only days processed by npm, starting at the first publication.
    data = fetch_json(NPM_DOWNLOADS)
    counts = {
        item["day"]: item["downloads"]
        for item in data["downloads"]
        if NPM_FIRST_DAY <= item["day"] <= data["end"]
    }
    if not counts:
        raise RuntimeError("npm has no download statistics for this package yet")
    return counts


def release_asset_counts():
    counts = {}
    token = os.environ.get("GITHUB_TOKEN")
    page = 1
    while True:
        releases = fetch_json(f"{GITHUB_RELEASES}?per_page=100&page={page}", token)
        for release in releases:
            if release["draft"]:
                continue
            for asset in release["assets"]:
                name = asset["name"]
                if name.startswith(PACKAGE) and name.endswith(".tgz"):
                    counts[str(asset["id"])] = asset["download_count"]
        if len(releases) < 100:
            return counts
        page += 1


def clone_counts():
    token = os.environ.get("DOWNLOAD_STATS_TRAFFIC_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("No GitHub traffic credential")
    report = fetch_json(GITHUB_CLONES, token)
    return {item["timestamp"][:10]: item["count"] for item in report["clones"]}


def collect_source(name, fetch_counts):
    try:
        return fetch_counts()
    except HTTPError as error:
        reason = f"HTTP {error.code}"
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        reason = type(error).__name__
    print(f"::warning::{name} refresh failed ({reason}). Keeping the last saved values.")
    return None


def update_history(history, npm_daily, github_assets, day, github_clones):
    if npm_daily is not None:
        history["npm_daily"].update(npm_daily)
    if github_clones is not None:
        history.setdefault("github_clones_daily", {}).update(github_clones)
    if github_assets is not None:
        # Keep the last reported count if a previously observed asset is removed.
        history["github_assets"].update(github_assets)
        history["github_snapshots"][day] = sum(history["github_assets"].values())


def draw_series(axes, days, totals, color, start):
    points = [
        (day, total)
        for key, total in zip(days, totals)
        if (day := date.fromisoformat(key)) >= start
    ]
    if points:
        dates, values = zip(*points)
        axes.plot(dates, values, color=color, linewidth=2.5, marker="o", markersize=4, zorder=3)


def render_chart(target, history):
    npm_days = sorted(history["npm_daily"])
    npm_total = list(accumulate(history["npm_daily"][day] for day in npm_days))
    github_days = sorted(history["github_snapshots"])
    github_total = [history["github_snapshots"][day] for day in github_days]
    clones_daily = history.get("github_clones_daily", {})
    clone_days = sorted(clones_daily)
    clone_total = list(accumulate(clones_daily[day] for day in clone_days))
    npm_value = f"{npm_total[-1]:,}" if npm_total else "Unavailable"
    github_value = f"{github_total[-1]:,}" if github_total else "Unavailable"
    clone_value = f"{clone_total[-1]:,}" if clone_total else "Unavailable"

    figure = plt.figure(figsize=(9.4, 4.8), dpi=140, facecolor="#ffffff")
    axes = figure.add_axes((0.094, 0.22, 0.86, 0.46))
    figure.text(0.094, 0.91, "dsh-a2ui downloads & clones", color="#18253b", fontsize=18, weight="bold")
    for x, label, value, color in (
        (0.094, "npm package", npm_value, NPM_COLOR),
        (0.385, "GitHub Release assets", github_value, GITHUB_COLOR),
        (0.73, "GitHub Clones", clone_value, CLONES_COLOR),
    ):
        figure.text(x, 0.82, label, color=color, fontsize=11, weight="bold")
        figure.text(x, 0.728, value, color=color, fontsize=24 if value != "Unavailable" else 13, weight="bold")

    all_days = [*npm_days, *github_days, *clone_days]
    end = date.fromisoformat(max(all_days))
    first = date.fromisoformat(min(all_days))
    start = max(first, end - timedelta(days=29))
    draw_series(axes, npm_days, npm_total, NPM_COLOR, start)
    draw_series(axes, github_days, github_total, GITHUB_COLOR, start)
    draw_series(axes, clone_days, clone_total, CLONES_COLOR, start)

    axes.set_xlim(mdates.date2num(start) - 0.35, mdates.date2num(end) + 0.35)
    upper = max((*npm_total, *github_total, *clone_total), default=0)
    axes.set_ylim(0, max(1, upper * 1.12))
    step = max(1, ((end - start).days + 5) // 6)
    axes.xaxis.set_major_locator(mdates.DayLocator(interval=step))
    axes.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    axes.yaxis.set_major_locator(MaxNLocator(nbins=5, integer=True))
    axes.yaxis.set_major_formatter(StrMethodFormatter("{x:,.0f}"))
    axes.tick_params(axis="both", length=0, pad=9, colors="#475569", labelsize=9)
    axes.grid(axis="y", color="#e3e9f2")
    for spine in axes.spines.values():
        spine.set_visible(False)

    npm_date = f"through {npm_days[-1]}" if npm_days else "unavailable"
    github_date = f"as of {github_days[-1]}" if github_days else "unavailable"
    figure.text(
        0.094, 0.092, f"npm {npm_date}  |  Release assets {github_date}  |  UTC",
        color="#475569", fontsize=9,
    )
    if clone_days:
        figure.text(
            0.094, 0.048, f"GitHub Clones recorded from {clone_days[0]} through {clone_days[-1]} UTC",
            color="#475569", fontsize=9,
        )
    figure.savefig(target)
    plt.close(figure)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Directory containing history.json and trend.png")
    output = parser.parse_args().output
    archive = output / "history.json"
    history = (
        json.loads(archive.read_text(encoding="utf-8"))
        if archive.exists()
        else {"npm_daily": {}, "github_assets": {}, "github_snapshots": {}}
    )
    today = datetime.now(timezone.utc).date()
    day = today.isoformat()
    scheduled = os.environ.get("GITHUB_EVENT_NAME") == "schedule"
    if scheduled and history.get("last_complete_scheduled_update") == day:
        print(f"Scheduled stats refresh already completed for {day} UTC.")
        return

    npm_daily = collect_source("npm", npm_counts)
    github_assets = collect_source("GitHub Releases", release_asset_counts)
    github_clones = collect_source("GitHub Clones", clone_counts)
    if not (npm_daily or github_assets is not None or github_clones):
        raise RuntimeError("No download or clone data refreshed. Keeping the previous chart.")

    update_history(history, npm_daily, github_assets, day, github_clones)
    if scheduled:
        yesterday = (today - timedelta(days=1)).isoformat()
        complete = (
            github_assets is not None
            and yesterday in (npm_daily or {})
            and yesterday in (github_clones or {})
        )
        if complete:
            history["last_complete_scheduled_update"] = day
        else:
            print(f"Some source data through {yesterday} UTC is pending. A later scheduled run can retry.")

    output.mkdir(parents=True, exist_ok=True)
    render_chart(output / "trend.png", history)
    archive.write_text(json.dumps(history, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    for name, key in (
        ("npm", "npm_daily"),
        ("GitHub Releases", "github_snapshots"),
        ("GitHub Clones", "github_clones_daily"),
    ):
        counts = history.get(key, {})
        if not counts:
            print(f"{name}: unavailable")
            continue
        latest = max(counts)
        total = counts[latest] if key == "github_snapshots" else sum(counts.values())
        print(f"{name}: {total:,} through {latest} UTC")


if __name__ == "__main__":
    main()
