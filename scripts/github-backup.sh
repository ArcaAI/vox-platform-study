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

# Fetch from GitHub to get existing branches
echo "Fetching from GitHub..."
git fetch github --all

# Get current branch and commit info
CURRENT_BRANCH=$(git branch --show-current)
CURRENT_COMMIT=$(git rev-parse HEAD)

echo "Current branch: $CURRENT_BRANCH"
echo "Current commit: $CURRENT_COMMIT"

# Check if backup branch exists on GitHub
if git show-ref --verify --quiet refs/remotes/github/$BACKUP_BRANCH; then
    echo "Branch '$BACKUP_BRANCH' exists on GitHub"
    
    # Checkout the backup branch
    if git branch --show-current != "$BACKUP_BRANCH"; then
        git checkout -b $BACKUP_BRANCH github/$BACKUP_BRANCH
    fi
    
    # Merge current changes into backup branch
    echo "Merging current changes into backup branch..."
    git merge $CURRENT_COMMIT --no-ff --allow-unrelated-histories -m "Merge $CURRENT_BRANCH into $BACKUP_BRANCH"
else
    echo "Branch '$BACKUP_BRANCH' does not exist on GitHub, creating it..."
    
    # Create backup branch from current commit
    git checkout -b $BACKUP_BRANCH $CURRENT_COMMIT
fi

# Push to GitHub
echo "Pushing to GitHub..."
git push github $BACKUP_BRANCH --force

echo "Successfully pushed changes to GitHub branch: $BACKUP_BRANCH"

# Return to original branch
if git branch --show-current != "$CURRENT_BRANCH"; then
    git checkout $CURRENT_BRANCH
fi

echo "GitHub backup completed!"
