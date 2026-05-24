#!/bin/bash
set -e

install -m 0700 -d "${PGDATA}"

cat > /home/postgres/postgres.yml <<YAML
scope: hope-cluster
namespace: /service
name: ${PATRONI_NAME}

restapi:
  listen: 0.0.0.0:8008
  connect_address: ${NODE_IP}:8008

etcd3:
  hosts:
    - ${PEER1_IP}:2379
    - ${PEER2_IP}:2379
    - ${PEER3_IP}:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    synchronous_mode: true
    synchronous_mode_strict: false
    synchronous_node_count: 1
    failsafe_mode: true
    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters:
        shared_preload_libraries: "timescaledb"
        timescaledb.max_background_workers: 16
        timescaledb.telemetry_level: "off"
        wal_level: replica
        hot_standby: "on"
        max_wal_senders: 10
        max_replication_slots: 10
        wal_log_hints: "on"
        archive_mode: "on"
        archive_command: "pgbackrest --stanza=hope-cluster archive-push \"%p\""
        archive_timeout: 60
        max_worker_processes: 27
        max_parallel_workers: 8
        password_encryption: scram-sha-256
        # Phase 0 of TASK-302 Stream C (PgBouncer rollout) — defensive PG timeouts
        # so a leaked transaction or runaway query can't pin a backend forever
        # and starve the connection pool. Units are milliseconds.
        # See: docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md
        idle_in_transaction_session_timeout: 30000   # 30 s
        statement_timeout: 60000                     # 60 s
      recovery_conf:
        recovery_target_timeline: latest
        restore_command: "pgbackrest --stanza=hope-cluster archive-get %f \"%p\""
  initdb:
    - encoding: UTF8
    - data-checksums
  pg_hba:
    - local all all peer
    - host all all 127.0.0.1/32 scram-sha-256
    - host all all ::1/128 scram-sha-256
    - host replication replicator 10.10.1.0/24 scram-sha-256
    - host all all 10.10.1.0/24 scram-sha-256
    - host all all 0.0.0.0/0 reject

postgresql:
  listen: 0.0.0.0:5432
  connect_address: ${NODE_IP}:5432
  data_dir: /home/postgres/pgdata/data
  bin_dir: /usr/lib/postgresql/18/bin
  pgpass: /tmp/pgpass0
  authentication:
    superuser:
      username: postgres
      password: "${PG_PASSWORD}"
    replication:
      username: replicator
      password: "${REPL_PASSWORD}"
  parameters:
    shared_preload_libraries: "timescaledb"
    timescaledb.max_background_workers: 16
    timescaledb.telemetry_level: "off"
    max_connections: 200
    shared_buffers: 4GB
    effective_cache_size: 12GB
    work_mem: 128MB
    maintenance_work_mem: 1GB
    wal_buffers: 64MB
    max_wal_size: 4GB
    min_wal_size: 1GB
    checkpoint_completion_target: 0.9
    checkpoint_timeout: 15min
    random_page_cost: 1.1
    effective_io_concurrency: 200
    max_worker_processes: 27
    max_parallel_workers_per_gather: 4
    max_parallel_workers: 8
    max_parallel_maintenance_workers: 4
    hot_standby: "on"
    wal_level: replica
    wal_log_hints: "on"
    archive_mode: "on"
    archive_command: "pgbackrest --stanza=hope-cluster archive-push \"%p\""
    archive_timeout: 60
    log_min_duration_statement: 1000
    log_checkpoints: "on"
    log_connections: "on"
    log_disconnections: "on"
    log_lock_waits: "on"
    log_timezone: UTC
    timezone: UTC
    password_encryption: scram-sha-256
    huge_pages: try
    # Phase 0 of TASK-302 Stream C (PgBouncer rollout) — see comment in bootstrap.dcs above.
    idle_in_transaction_session_timeout: 30000
    statement_timeout: 60000
  create_replica_methods:
    - pgbackrest
    - basebackup
  pgbackrest:
    command: pgbackrest --stanza=hope-cluster restore --type=none
    keep_data: true
    no_params: true
  basebackup:
    checkpoint: fast
    max-rate: 100M

watchdog:
  mode: automatic
  device: /dev/watchdog
  safety_margin: 5

tags:
  nofailover: false
  noloadbalance: false
  clonefrom: false
  nosync: false
YAML

chown postgres:postgres /home/postgres/postgres.yml

if [ -f "${PGDATA}/postmaster.pid" ]; then
  rm "${PGDATA}/postmaster.pid"
  sleep 5
fi

exec patroni /home/postgres/postgres.yml
