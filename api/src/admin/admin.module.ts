import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AdminController } from './admin.controller';
import { HealthController } from './health.controller';
import { LeadsController } from './leads.controller';

@Module({ controllers: [AdminController, AccountController, HealthController, LeadsController] })
export class AdminModule {}
