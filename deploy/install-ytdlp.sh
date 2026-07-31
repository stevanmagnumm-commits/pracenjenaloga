#!/bin/bash
# Installs yt-dlp (standalone binary, no python needed) and a weekly self-update.
#
# The TikTok downloader prefers yt-dlp over RapidAPI: it costs nothing, has no
# daily cap and returns the original 1080p file. The catch is that TikTok changes
# its page format every few months, and a stale binary then fails on every link —
# hence the cron job below.
set -euo pipefail

BIN=/usr/local/bin/yt-dlp
URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux

echo "==> installing $BIN"
curl -sSL "$URL" -o "$BIN.new"
chmod +x "$BIN.new"
"$BIN.new" --version >/dev/null
mv "$BIN.new" "$BIN"
echo "    version: $($BIN --version)"

echo "==> installing weekly update cron"
cat > /etc/cron.weekly/yt-dlp-update <<EOF
#!/bin/bash
# Keep yt-dlp current, otherwise TikTok extraction breaks silently.
curl -sSL $URL -o $BIN.new && chmod +x $BIN.new && $BIN.new --version >/dev/null \\
  && mv $BIN.new $BIN || rm -f $BIN.new
EOF
chmod +x /etc/cron.weekly/yt-dlp-update

echo "==> done"
