import { ApiProperty } from '@nestjs/swagger';

export class UsageTimeseriesPoint {
  @ApiProperty({ description: 'UTC bucket start, ISO-8601.' })
  bucketStart!: string;

  @ApiProperty({ description: 'Summed quantity in `unit`, across every provider/model.' })
  quantity!: string;

  @ApiProperty({ description: 'Summed INTERNAL-basis rated cost, integer micros.' })
  costMicros!: string;
}

export class UsageTimeseriesResponse {
  @ApiProperty()
  capability!: string;

  @ApiProperty()
  unit!: string;

  @ApiProperty({ enum: ['day', 'hour'] })
  granularity!: 'day' | 'hour';

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty({ type: UsageTimeseriesPoint, isArray: true })
  points!: UsageTimeseriesPoint[];
}
