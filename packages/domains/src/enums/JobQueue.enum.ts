// TODO: move the JobQueue to the application layer as a configuration

export enum JobQueue {
    AuditLog = 'AuditLog',
    UserActivity = 'UserActivity',
    SendEmail = 'SendEmail',
    SendSms = 'SendSms',
    ReceiveEmail = 'ReceiveEmail',
    ReceiveSms = 'ReceiveSms',
    SysEvent = 'SysEvent',
    WebCrawler = 'WebCrawler',

    SpeechToText = 'SpeechToText',

    // Consultation AI Processing Queues
    GeneratePreSummary = 'GeneratePreSummary',
    GenerateSummary = 'GenerateSummary',
    GenerateComprehensiveSummary = 'GenerateComprehensiveSummary',
    ExtractNamedEntities = 'ExtractNamedEntities',

    // DNA Writing Style Analysis
    GenerateDnaReport = 'GenerateDnaReport',
}
