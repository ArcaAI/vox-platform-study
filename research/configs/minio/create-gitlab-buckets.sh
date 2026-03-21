#!/bin/bash
##############################################################################
# Create all MinIO buckets required by GitLab
#
# Prerequisites:
#   - MinIO is running on VM 402
#   - mc (MinIO Client) is installed and alias configured:
#       mc alias set homelab http://10.10.1.102:9000 <ACCESS_KEY> <SECRET_KEY>
#
# Usage:
#   chmod +x create-gitlab-buckets.sh
#   ./create-gitlab-buckets.sh
##############################################################################

set -euo pipefail

ALIAS="homelab"

BUCKETS=(
  gitlab-artifacts
  gitlab-lfs
  gitlab-uploads
  gitlab-packages
  gitlab-mr-diffs
  gitlab-terraform-state
  gitlab-ci-secure-files
  gitlab-pages
  gitlab-dependency-proxy
  gitlab-registry
  gitlab-backups
  gitlab-runner-cache
)

echo "Creating GitLab buckets on MinIO ($ALIAS)..."
for bucket in "${BUCKETS[@]}"; do
  if mc ls "$ALIAS/$bucket" &>/dev/null; then
    echo "  [exists] $bucket"
  else
    mc mb "$ALIAS/$bucket"
    echo "  [created] $bucket"
  fi
done

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "SERVICE ACCOUNT 1: gitlab-svc (GitLab Object Storage)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  Run these commands manually:"
echo ""
echo "  mc admin user add $ALIAS gitlab-svc <STRONG_PASSWORD>"
echo ""
echo "  Create a policy file (gitlab-policy.json):"
cat <<'POLICY'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload"
      ],
      "Resource": [
        "arn:aws:s3:::gitlab-artifacts",
        "arn:aws:s3:::gitlab-artifacts/*",
        "arn:aws:s3:::gitlab-lfs",
        "arn:aws:s3:::gitlab-lfs/*",
        "arn:aws:s3:::gitlab-uploads",
        "arn:aws:s3:::gitlab-uploads/*",
        "arn:aws:s3:::gitlab-packages",
        "arn:aws:s3:::gitlab-packages/*",
        "arn:aws:s3:::gitlab-mr-diffs",
        "arn:aws:s3:::gitlab-mr-diffs/*",
        "arn:aws:s3:::gitlab-terraform-state",
        "arn:aws:s3:::gitlab-terraform-state/*",
        "arn:aws:s3:::gitlab-ci-secure-files",
        "arn:aws:s3:::gitlab-ci-secure-files/*",
        "arn:aws:s3:::gitlab-pages",
        "arn:aws:s3:::gitlab-pages/*",
        "arn:aws:s3:::gitlab-dependency-proxy",
        "arn:aws:s3:::gitlab-dependency-proxy/*",
        "arn:aws:s3:::gitlab-registry",
        "arn:aws:s3:::gitlab-registry/*",
        "arn:aws:s3:::gitlab-backups",
        "arn:aws:s3:::gitlab-backups/*"
      ]
    }
  ]
}
POLICY
echo ""
echo "  mc admin policy create $ALIAS gitlab-policy gitlab-policy.json"
echo "  mc admin policy attach $ALIAS gitlab-policy --user gitlab-svc"
echo ""
echo "  → Use gitlab-svc credentials in gitlab.rb section 7 (Object Storage)."
echo ""
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "SERVICE ACCOUNT 2: runner-svc (GitLab Runner S3 Cache)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  mc admin user add $ALIAS runner-svc <STRONG_PASSWORD>"
echo ""
echo "  Create a policy file (runner-cache-policy.json):"
cat <<'RUNNER_POLICY'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload"
      ],
      "Resource": [
        "arn:aws:s3:::gitlab-runner-cache",
        "arn:aws:s3:::gitlab-runner-cache/*"
      ]
    }
  ]
}
RUNNER_POLICY
echo ""
echo "  mc admin policy create $ALIAS runner-cache-policy runner-cache-policy.json"
echo "  mc admin policy attach $ALIAS runner-cache-policy --user runner-svc"
echo ""
echo "  → Use runner-svc credentials in config.toml [runners.cache.s3] sections."
echo ""
echo "Done."
