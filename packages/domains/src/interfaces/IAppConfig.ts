export interface IAppConfig {
  //=========== APPLICATION ============//
  NODE_ENV: 'production' | 'development' | string;
  DEBUG: boolean;
  NEST_DEBUG: boolean;
  SERVICE_NAME: string;

  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  //=========== FILE LOGGING ============//
  LOG_FILE_ENABLED?: boolean;
  LOG_FILE_PATH?: string;
  LOG_FILE_MAX_SIZE?: string;
  LOG_FILE_MAX_FILES?: number;
  LOG_FILE_DATE_PATTERN?: string;
  LOG_FILE_SEPARATE_ERROR?: boolean;

  //=========== INTERNAL SERVICES ============//
  PORT: string;
  URL: string;
  STT_V2_URL: string;
  TTS_PORT: string;
  TTS_URL: string;
  SMR_PORT: string;
  SMR_URL: string;
  NLP_PORT: string;
  NLP_URL: string;
  FEDL_PORT: string;
  FEDL_URL: string;

  //=========== MQTT ============//
  MQTT_HOST: string;
  MQTT_PORT: number;
  MQTT_USER: string;
  MQTT_PASS: string;

  //=========== REDIS ============//
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASS: string;
}
