#!/bin/bash

set -e

cd "$(dirname "$0")"

VERSION="$(date '+%Y%m%d%H%M%S')"
BUILT_AT="$(date '+%Y-%m-%dT%H:%M:%S%z')"

cat > version.json <<EOF
{
  "version": "$VERSION",
  "builtAt": "$BUILT_AT"
}
EOF

echo "已產生網站版本：$VERSION"

git add index.html version.json deploy.sh

if git diff --cached --quiet; then
  echo "目前沒有需要部署的變更。"
  exit 0
fi

git commit -m "Deploy admin website $VERSION"
git push origin main

echo "部署完成：$VERSION"
echo "已開啟的後台會在 60 秒內自動更新。"
