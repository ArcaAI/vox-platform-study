#!/usr/bin/env bash
# Create (or update) the three Secrets Manager secrets for one environment.
#
#   ENV=dev AWS_REGION=ap-southeast-1 ./provision.sh
#
# Fill the __PLACEHOLDER__ values in the *.template.json files FIRST, into a
# working copy OUTSIDE the repo. This script refuses to upload a file that still
# contains a placeholder.
set -euo pipefail

: "${ENV:?set ENV=dev|staging|prod}"
: "${AWS_REGION:?set AWS_REGION}"
SRC="${SRC:-$(pwd)}"          # directory holding the filled hope-*.json files
KMS_ALIAS="alias/hope-${ENV}-secretsmanager"

for group in platform services providers; do
  f="${SRC}/hope-${group}.json"
  [[ -f "$f" ]] || { echo "missing $f — copy hope-${group}.template.json and fill it"; exit 1; }

  if grep -q '__[A-Z0-9_]*__' "$f"; then
    echo "REFUSING: $f still contains unfilled __PLACEHOLDER__ values:"
    grep -o '__[A-Z0-9_]*__' "$f" | sort -u | sed 's/^/  /'
    exit 1
  fi

  # Strip the _comment key before upload — it is documentation, not config.
  payload="$(jq 'del(._comment)' "$f")"

  if aws secretsmanager describe-secret --secret-id "hope/${ENV}/${group}" \
       --region "$AWS_REGION" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --secret-id "hope/${ENV}/${group}" \
      --secret-string "$payload" \
      --region "$AWS_REGION" >/dev/null
    echo "updated  hope/${ENV}/${group}"
  else
    aws secretsmanager create-secret \
      --name "hope/${ENV}/${group}" \
      --kms-key-id "$KMS_ALIAS" \
      --secret-string "$payload" \
      --region "$AWS_REGION" >/dev/null
    echo "created  hope/${ENV}/${group}  (kms: ${KMS_ALIAS})"
  fi
done

cat <<EOF

Next:
  kubectl -n hope-v2-${ENV} get externalsecret hope-secrets     # expect SecretSynced
  kubectl -n hope-v2-${ENV} get secret hope-secrets -o json | \\
    jq '.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] // "absent"'
                                                                # expect "absent"
EOF
