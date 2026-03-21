##############################################################################
# GitLab Omnibus Configuration — Production Homelab
#
# Location on VM 410:  /srv/gitlab/config/gitlab.rb
# Managed copy:        docs/research/configs/gitlab/gitlab.rb
#
# After editing this file, reconfigure GitLab:
#   docker exec -it gitlab gitlab-ctl reconfigure
#
# Reference: https://docs.gitlab.com/omnibus/settings/
##############################################################################


## ═══════════════════════════════════════════════════════════════════════════
## 1. CORE
## ═══════════════════════════════════════════════════════════════════════════

external_url 'https://git.taphuynh.dev'

gitlab_rails['time_zone'] = 'Australia/Sydney'


## ═══════════════════════════════════════════════════════════════════════════
## 2. NGINX — Cloudflare Terminates TLS
## ═══════════════════════════════════════════════════════════════════════════

nginx['listen_port'] = 80
nginx['listen_https'] = false

nginx['proxy_set_headers'] = {
  "X-Forwarded-Proto" => "https",
  "X-Forwarded-Ssl"   => "on"
}

# Trust Cloudflare IP ranges + internal network for real client IP
nginx['real_ip_trusted_addresses'] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '10.10.1.0/24'
]
nginx['real_ip_header'] = 'CF-Connecting-IP'
nginx['real_ip_recursive'] = 'on'

# Large push / LFS upload support
# NOTE: This only affects the NGINX limit on GitLab's side. Cloudflare Free
# tier enforces a 100 MB HTTP upload limit BEFORE traffic reaches this server.
# External users MUST use SSH for Git operations to bypass this limit.
nginx['client_max_body_size'] = '500m'

# Gzip compression
nginx['gzip_enabled'] = true


## ═══════════════════════════════════════════════════════════════════════════
## 3. SSH — gitlab-sshd (Go-based SSH server)
## ═══════════════════════════════════════════════════════════════════════════
##
## Uses gitlab-sshd instead of OpenSSH. Benefits:
##   - Listens on port 2222 inside the container (matches Docker mapping 2222:2222)
##   - Lower memory than OpenSSH, multi-threaded Go server
##   - PROXY protocol support (useful behind Cloudflare Tunnel / load balancers)
##
## Tradeoffs vs OpenSSH:
##   - No 2FA recovery code regeneration via SSH
##   - No SSH certificate support
##
## Ref: https://docs.gitlab.com/ee/administration/operations/gitlab_sshd.html

gitlab_rails['gitlab_shell_ssh_port'] = 2222

gitlab_sshd['enable'] = true
gitlab_sshd['listen_address'] = '[::]:2222'


## ═══════════════════════════════════════════════════════════════════════════
## 4. CONTAINER REGISTRY
## ═══════════════════════════════════════════════════════════════════════════
##
## CLOUDFLARE FREE TIER NOTE:
## External access via registry.taphuynh.dev has a 100 MB HTTP upload limit.
## Internal VMs (Runner, Rancher) should resolve registry.taphuynh.dev to
## 10.10.1.110 via /etc/hosts to bypass Cloudflare entirely.
## See: deploy-vm411-gitlab-runner.md (step 3.1) for the Runner workaround.

## The registry_external_url MUST use http:// — NOT https://.
##
## Why: The Container Registry generates Location headers for blob uploads
## using this URL's scheme. If set to https://, the registry returns
## Location: https://10.10.1.110:5050/... in API responses. The Docker
## client follows the redirect to HTTPS, but NGINX only listens on HTTP →
## "http: server gave HTTP response to HTTPS client".
##
## Cloudflare handles TLS for external clients (registry.taphuynh.dev).
## Internal clients (Runner on VM 411) connect directly to 10.10.1.110:5050
## over plain HTTP. Both paths work correctly with http:// here.
registry_external_url 'http://registry.taphuynh.dev'

registry_nginx['listen_port'] = 5050
registry_nginx['listen_https'] = false

# Auth token realm — where the registry sends Docker clients to get a JWT.
#
# MUST be HTTP + internal IP because:
#   - The build runner (VM 411) resolves git.taphuynh.dev → 10.10.1.110
#     via /etc/hosts (to bypass Cloudflare 100 MB limit)
#   - GitLab NGINX only listens on port 80 (Cloudflare terminates TLS)
#   - If realm is HTTPS, Docker tries 10.10.1.110:443 → nothing listens → fails
#     with "http: server gave HTTP response to HTTPS client"
#
# Using the internal IP avoids DNS/hosts resolution issues entirely.
# External clients (via Cloudflare) don't use this — they go through the
# tunnel which terminates TLS and forwards to port 80.
gitlab_rails['registry_issuer'] = 'omnibus-gitlab-issuer'
registry['token_realm'] = 'http://10.10.1.110'

# Registry storage is configured in section 7 (Object Storage — MinIO).
# If MinIO is not deployed, uncomment the filesystem block below:
# registry['storage'] = {
#   'filesystem' => {
#     'rootdirectory' => '/var/opt/gitlab/gitlab-rails/shared/registry'
#   },
#   'delete' => { 'enabled' => true }
# }

# Registry garbage collection — remove untagged manifests
# Run manually: docker exec gitlab gitlab-ctl registry-garbage-collect -m
# Scheduled via cron on the host (see plan doc)


## ═══════════════════════════════════════════════════════════════════════════
## 5. PERFORMANCE TUNING — 8 vCPU / 16 GB RAM
## ═══════════════════════════════════════════════════════════════════════════

### Puma (web server)
# 4 workers × 4 threads = 16 concurrent web requests
puma['worker_processes'] = 4
puma['min_threads'] = 4
puma['max_threads'] = 4
puma['per_worker_max_memory_mb'] = 1200

### Sidekiq (background jobs)
sidekiq['max_concurrency'] = 10
sidekiq['min_concurrency'] = 5

### PostgreSQL
postgresql['shared_buffers']                = '2048MB'
postgresql['work_mem']                      = '64MB'
postgresql['maintenance_work_mem']          = '256MB'
postgresql['effective_cache_size']          = '6GB'
postgresql['max_worker_processes']          = 8
postgresql['max_parallel_workers_per_gather'] = 2
postgresql['max_parallel_maintenance_workers'] = 2
postgresql['wal_buffers']                   = '16MB'
postgresql['checkpoint_completion_target']  = 0.9

### Gitaly (Git RPC server)
gitaly['configuration'] = {
  concurrency: [
    { rpc: '/gitaly.SmartHTTPService/PostReceivePack', max_per_repo: 3 },
    { rpc: '/gitaly.SSHService/SSHUploadPack', max_per_repo: 3 },
  ],
  cgroups: {
    mountpoint: '/sys/fs/cgroup',
    hierarchy_root: 'gitaly',
    memory_bytes: 6442450944,   # 6 GB
    cpu_shares: 1024,
  }
}
gitaly['env'] = {
  'GITALY_COMMAND_SPAWN_MAX_PARALLEL' => '2',
  'MALLOC_CONF' => 'dirty_decay_ms:1000,muzzy_decay_ms:1000'
}


## ═══════════════════════════════════════════════════════════════════════════
## 6. SECURITY
## ═══════════════════════════════════════════════════════════════════════════

# Disable public registration
gitlab_rails['gitlab_signup_enabled'] = false

# Session timeout — 12 hours
gitlab_rails['session_expire_delay'] = 720

# Password policy
gitlab_rails['password_minimum_length'] = 12

# Rate limiting — brute-force protection
gitlab_rails['rate_limiting_response_text'] = 'Retry later'
gitlab_rails['rack_attack_git_basic_auth'] = {
  'enabled'    => true,
  'ip_whitelist' => ['10.10.1.0/24'],
  'maxretry'   => 10,
  'findtime'   => 60,
  'bantime'    => 3600
}

# Impersonation (admin can impersonate users for debugging)
gitlab_rails['impersonation_enabled'] = true


## ═══════════════════════════════════════════════════════════════════════════
## 7. OBJECT STORAGE — MinIO (S3-compatible)
## ═══════════════════════════════════════════════════════════════════════════
##
## MinIO runs on VM 402 (10.10.1.102:9000).
## Create these buckets in MinIO before enabling:
##   - gitlab-artifacts
##   - gitlab-lfs
##   - gitlab-uploads
##   - gitlab-packages
##   - gitlab-mr-diffs
##   - gitlab-terraform-state
##   - gitlab-ci-secure-files
##   - gitlab-pages
##   - gitlab-dependency-proxy
##   - gitlab-registry   (if migrating registry to S3)
##   - gitlab-backups
##
## Uncomment sections below once MinIO is deployed on VM 402.
## ─────────────────────────────────────────────────────────────────────────

### Consolidated object storage (GitLab 16+ unified config)
gitlab_rails['object_store']['enabled'] = true
gitlab_rails['object_store']['proxy_download'] = true
gitlab_rails['object_store']['connection'] = {
  'provider'              => 'AWS',
  'endpoint'              => 'http://10.10.1.102:9000',
  'aws_access_key_id'     => 'Z10LR5DPC2GNBWTNU7M6',
  'aws_secret_access_key' => '2n+Lc0fHpsO0O+b5qLCZEduUWzj5SeCrI2smF23O',
  'region'                => 'us-east-1',
  'path_style'            => true
}
gitlab_rails['object_store']['objects']['artifacts']['bucket'] = 'gitlab-artifacts'
gitlab_rails['object_store']['objects']['lfs']['bucket'] = 'gitlab-lfs'
gitlab_rails['object_store']['objects']['uploads']['bucket'] = 'gitlab-uploads'
gitlab_rails['object_store']['objects']['packages']['bucket'] = 'gitlab-packages'
gitlab_rails['object_store']['objects']['external_diffs']['bucket'] = 'gitlab-mr-diffs'
gitlab_rails['object_store']['objects']['terraform_state']['bucket'] = 'gitlab-terraform-state'
gitlab_rails['object_store']['objects']['ci_secure_files']['bucket'] = 'gitlab-ci-secure-files'
gitlab_rails['object_store']['objects']['pages']['bucket'] = 'gitlab-pages'
gitlab_rails['object_store']['objects']['dependency_proxy']['bucket'] = 'gitlab-dependency-proxy'

### Registry on MinIO (separate from consolidated config)
registry['storage'] = {
  's3' => {
    'accesskey'      => 'Z10LR5DPC2GNBWTNU7M6',
    'secretkey'      => '2n+Lc0fHpsO0O+b5qLCZEduUWzj5SeCrI2smF23O',
    'region'         => 'us-east-1',
    'regionendpoint' => 'http://10.10.1.102:9000',
    'bucket'         => 'gitlab-registry',
    'pathstyle'      => true
  },
  'delete' => { 'enabled' => true },
  'redirect' => { 'disable' => true }
}

### Backups to MinIO
gitlab_rails['backup_upload_connection'] = {
  'provider'              => 'AWS',
  'endpoint'              => 'http://10.10.1.102:9000',
  'aws_access_key_id'     => 'Z10LR5DPC2GNBWTNU7M6',
  'aws_secret_access_key' => '2n+Lc0fHpsO0O+b5qLCZEduUWzj5SeCrI2smF23O',
  'region'                => 'us-east-1',
  'path_style'            => true
}
gitlab_rails['backup_upload_remote_directory'] = 'gitlab-backups'


## ═══════════════════════════════════════════════════════════════════════════
## 8. SSO / AUTHENTICATION — Azure AD (Microsoft Entra ID) via OIDC
## ═══════════════════════════════════════════════════════════════════════════
##
## Prerequisites (Azure Portal):
##   1. App Registration: "GitLab SSO" in Entra ID
##      - Redirect URI: https://git.taphuynh.dev/users/auth/openid_connect/callback
##   2. API permissions: Microsoft Graph → Delegated → openid, profile, email
##   3. Client secret generated (24-month expiry recommended)
##   4. Note: Tenant ID, Client ID, Client Secret
##
## See: deploy-vm410-gitlab.md § "Azure AD SSO Setup" for full walkthrough.
## ─────────────────────────────────────────────────────────────────────────

gitlab_rails['omniauth_enabled'] = true
gitlab_rails['omniauth_allow_single_sign_on'] = ['openid_connect']
gitlab_rails['omniauth_sync_email_from_provider'] = 'openid_connect'
gitlab_rails['omniauth_sync_profile_from_provider'] = ['openid_connect']
gitlab_rails['omniauth_sync_profile_attributes'] = ['name', 'email']
gitlab_rails['omniauth_block_auto_created_users'] = true
gitlab_rails['omniauth_auto_link_user'] = ['openid_connect']

gitlab_rails['omniauth_providers'] = [
  {
    name: "openid_connect",
    label: "Azure AD",
    args: {
      name: "openid_connect",
      scope: ["openid", "profile", "email"],
      response_type: "code",
      issuer: "https://login.microsoftonline.com/187af2bd-d4ca-45b1-8de7-6285277a6e74/v2.0",
      client_auth_method: "query",
      discovery: true,
      uid_field: "preferred_username",
      send_scope_to_token_endpoint: "false",
      pkce: true,
      client_options: {
        identifier: "62d65a2f-879e-45e4-943b-446dd2d2d3ed",
        secret: "g~H8Q~CPF~2eSIigoWDuc2EexoGHCFjtRXA8mauY",
        redirect_uri: "https://git.taphuynh.dev/users/auth/openid_connect/callback"
      }
    }
  }
]


## ═══════════════════════════════════════════════════════════════════════════
## 9. EMAIL — Office 365 SMTP via Delegated SMTP.Send
## ═══════════════════════════════════════════════════════════════════════════
##
## Sends email via smtp.office365.com using a shared mailbox authenticated
## with the mailbox user password. The Entra ID app registration holds the
## delegated SMTP.Send permission; the service principal is granted
## FullAccess to the shared mailbox in Exchange Online.
##
## Prerequisites (Azure Portal + Exchange Online PowerShell):
##   1. Shared mailbox: gitlab-noreply@4bits.vn (no M365 license needed)
##   2. App Registration: "GitLab SMTP" in Entra ID (single-tenant)
##      - API permission: Microsoft Graph → Delegated → SMTP.Send
##      - Admin consent granted
##   3. Service principal created in Exchange Online for the app
##   4. FullAccess mailbox permission granted to the service principal
##   5. SMTP client auth enabled on the shared mailbox
##
## See: deploy-vm410-gitlab.md § "Office 365 SMTP Setup" for walkthrough.
## ─────────────────────────────────────────────────────────────────────────

gitlab_rails['smtp_enable'] = true
gitlab_rails['smtp_address'] = 'smtp.office365.com'
gitlab_rails['smtp_port'] = 587
gitlab_rails['smtp_user_name'] = "gitlab-noreply@4bits.vn"
gitlab_rails['smtp_password'] = "Hi@ll1234bits"
gitlab_rails['smtp_domain'] = "4bits.vn"
gitlab_rails['smtp_authentication'] = "login"
gitlab_rails['smtp_enable_starttls_auto'] = true
gitlab_rails['smtp_tls'] = false
gitlab_rails['smtp_openssl_verify_mode'] = 'peer'
gitlab_rails['smtp_pool'] = true

gitlab_rails['gitlab_email_from'] = 'gitlab-noreply@4bits.vn'
gitlab_rails['gitlab_email_display_name'] = 'GitLab'
gitlab_rails['gitlab_email_reply_to'] = 'gitlab-noreply@4bits.vn'
gitlab_rails['gitlab_email_subject_suffix'] = '[GitLab]'


## ═══════════════════════════════════════════════════════════════════════════
## 10. BACKUPS
## ═══════════════════════════════════════════════════════════════════════════

gitlab_rails['backup_keep_time'] = 604800      # 7 days
gitlab_rails['backup_archive_permissions'] = 0644

# Exclude large/recoverable data from backup to reduce size:
# gitlab_rails['env'] = { 'SKIP' => 'artifacts,builds,registry' }


## ═══════════════════════════════════════════════════════════════════════════
## 11. BUILT-IN MONITORING — Disabled
## ═══════════════════════════════════════════════════════════════════════════
##
## Disabled to save resources. Re-enable the GitLab exporter when an external
## Prometheus instance is deployed (e.g., on VM 400 master cluster or elsewhere).

# prometheus_monitoring['enable'] = false
# grafana['enable'] = false
# alertmanager['enable'] = false
# node_exporter['enable'] = false
# redis_exporter['enable'] = false
# postgres_exporter['enable'] = false

# GitLab metrics exporter — enable when external Prometheus is ready
# gitlab_exporter['enable'] = true
# gitlab_exporter['listen_address'] = '0.0.0.0'
# gitlab_exporter['listen_port'] = 9168

# gitlab_exporter['enable'] = false


## ═══════════════════════════════════════════════════════════════════════════
## 12. PAGES — Static Site Hosting (path-based, no wildcard DNS)
## ═══════════════════════════════════════════════════════════════════════════
##
## URL pattern: https://pages.taphuynh.dev/<namespace>/<project>/
##
## We use namespace_in_path mode because Cloudflare's free Universal SSL
## only covers *.taphuynh.dev (one level). Wildcard subdomains like
## *.pages.taphuynh.dev require Advanced Certificate Manager (~$10/month).
## Path-based mode avoids this by serving all Pages under a single subdomain.
##
## Cloudflare setup:
##   1. DNS: CNAME pages.taphuynh.dev → <tunnel-id>.cfargotunnel.com (proxied)
##      (NOT *.pages — just "pages")
##   2. Tunnel ingress rule: pages.taphuynh.dev → http://10.10.1.110:8090
##   3. Expose port 8090 in docker-compose.yml
##
## Object storage: uses 'gitlab-pages' bucket via consolidated config (section 7).

pages_external_url 'https://pages.taphuynh.dev'
gitlab_pages['namespace_in_path'] = true

### Pages NGINX (reverse proxy inside the container)
pages_nginx['listen_port'] = 8090
pages_nginx['listen_https'] = false
pages_nginx['proxy_set_headers'] = {
  "X-Forwarded-Proto" => "https",
  "X-Forwarded-Ssl"   => "on"
}

### Pages daemon
gitlab_pages['enable'] = true
gitlab_pages['access_control'] = true
gitlab_pages['internal_gitlab_server'] = 'http://localhost:8080'
gitlab_pages['listen_proxy'] = 'localhost:8091'
gitlab_pages['log_verbose'] = true


## ═══════════════════════════════════════════════════════════════════════════
## 13. CI/CD DEFAULTS
## ═══════════════════════════════════════════════════════════════════════════

# Default artifacts expiration (30 days — prevents disk bloat)
gitlab_rails['default_artifacts_expire_in'] = '90 days'

# Package registry
gitlab_rails['packages_enabled'] = true

# Container registry cleanup policies
gitlab_rails['container_registry_token_expire_delay'] = 300


## ═══════════════════════════════════════════════════════════════════════════
## 14. ADVANCED — Uncommon Settings
## ═══════════════════════════════════════════════════════════════════════════

### Git settings
# gitlab_rails['git_max_size'] = 0                     # 0 = unlimited push size
# gitlab_rails['git_timeout'] = 10                     # seconds

### Housekeeping
gitlab_rails['housekeeping_enabled'] = true

### Repository storage (default is fine for single-node)
# git_data_dirs({
#   'default' => { 'path' => '/var/opt/gitlab/git-data' }
# })
