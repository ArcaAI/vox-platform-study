#!/bin/bash

# GitHub Backup Script
# This script adds GitHub as a remote and pushes current changes to the backup branch

set -eu

# Configuration
GITHUB_REPO="https://github.com/4bits-vn/project-hope-v2.git"
GITHUB_USERNAME="VuVux520"
GITHUB_TOKEN="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"
BACKUP_BRANCH="back-up"

# Create authenticated GitHub URL
GITHUB_AUTH_URL="https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@${GITHUB_REPO#https://}"

echo "Setting up GitHub backup..."

# Check if github remote already exists
if ! git remote show github 2>/dev/null; then
    echo "Adding GitHub remote..."
    git remote add github "$GITHUB_AUTH_URL"
else
    echo "GitHub remote already exists, updating URL..."
    git remote set-url github "$GITHUB_AUTH_URL"
fi

# Get current branch and commit info
CURRENT_BRANCH=$(git branch --show-current)
CURRENT_COMMIT=$(git rev-parse HEAD)

echo "Current branch: $CURRENT_BRANCH"
echo "Current commit: $CURRENT_COMMIT"

# Force-push current HEAD to the backup branch on GitHub (mirror style)
echo "Force-pushing $CURRENT_BRANCH to GitHub branch: $BACKUP_BRANCH ..."
git push github "HEAD:refs/heads/$BACKUP_BRANCH" --force

echo "Successfully pushed $CURRENT_COMMIT to GitHub branch: $BACKUP_BRANCH"
echo "GitHub backup completed!"
