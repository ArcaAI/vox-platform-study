// import { Controller, Get, Inject, Query, Param } from '@nestjs/common';
// import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';

// import {
//   IMonitoringService,
//   SystemMetrics,
//   KpiDataPoint,
//   IntegrationStatus
// } from '../../../interfaces';

// @ApiTags('monitoring')
// @Controller('monitoring')
// export class MonitoringController {
//   constructor(
//     @Inject(IMonitoringService) private readonly monitoringService: IMonitoringService
//   ) {}

//   @Get('/system')
//   @ApiOperation({ summary: 'Get current system metrics' })
//   @ApiResponse({ status: 200, description: 'System metrics' })
//   async getSystemMetrics(): Promise<SystemMetrics> {
//     return this.monitoringService.getSystemMetrics();
//   }

//   @Get('/integrations')
//   @ApiOperation({ summary: 'Get integration status' })
//   @ApiResponse({ status: 200, description: 'Integration status information' })
//   async getIntegrationStatus(): Promise<IntegrationStatus[]> {
//     return this.monitoringService.checkIntegrationStatus();
//   }

//   @Get('/kpi/:metricName')
//   @ApiOperation({ summary: 'Get historical KPI data for a specific metric' })
//   @ApiParam({ name: 'metricName', description: 'Name of the KPI metric to query' })
//   @ApiQuery({ name: 'startTime', description: 'Start time for the query period (ISO string)' })
//   @ApiQuery({ name: 'endTime', description: 'End time for the query period (ISO string)' })
//   @ApiQuery({
//     name: 'aggregation',
//     description: 'Aggregation method',
//     enum: ['avg', 'sum', 'max', 'min'],
//     required: false
//   })
//   @ApiResponse({ status: 200, description: 'Historical KPI data' })
//   async getKpiHistory(
//     @Param('metricName') metricName: string,
//     @Query('startTime') startTime: string,
//     @Query('endTime') endTime: string,
//     @Query('aggregation') aggregation?: 'avg' | 'sum' | 'max' | 'min'
//   ): Promise<KpiDataPoint[]> {
//     return this.monitoringService.getKpiHistory(
//       metricName,
//       new Date(startTime),
//       new Date(endTime),
//       aggregation
//     );
//   }
// }