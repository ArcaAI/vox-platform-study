# API Gateway Documentation

Welcome to the HOPE API Gateway documentation. This directory contains comprehensive guides and references for developers, operators, and integrators.

## Documentation Structure

### 📚 Core Documentation

#### [01 - Implementation Status](./01-implementation-status.md)

**Audience**: Project Managers, Developers, Stakeholders

Track the current state of API Gateway features:

- ✅ Completed features and endpoints
- 🔄 Work in progress
- 🟡 Planned enhancements
- 📊 Overall completion metrics

**When to read**: Before planning new features or understanding what's available

---

#### [02 - Development Guide](./02-development-guide.md)

**Audience**: Backend Developers, New Team Members

Comprehensive guide for local development:

- Environment setup (Node.js, PostgreSQL, Redis)
- Creating new features and endpoints
- Working with database migrations
- Authentication and authorization
- Testing strategies
- Debugging techniques
- Best practices and coding standards

**When to read**: When joining the project or implementing new features

---

#### [03 - Usage Guide](./03-usage-guide.md)

**Audience**: Frontend Developers, Integration Partners, API Consumers

Practical API usage examples:

- Authentication methods (JWT, API Key, OIDC)
- Complete endpoint reference with examples
- Request/response formats
- Error handling
- Rate limiting guidelines
- WebSocket communication
- SDK integration examples
- Code examples in multiple languages

**When to read**: When integrating with the API or building client applications

---

#### [04 - Deployment Guide](./04-deployment-guide.md)

**Audience**: DevOps Engineers, System Administrators, Platform Engineers

Production deployment instructions:

- Infrastructure requirements
- Docker deployment
- Single server setup with systemd
- Kubernetes deployment with Helm
- Cloud platform deployment (Azure, AWS, GCP)
- Post-deployment verification
- Monitoring and maintenance
- Security hardening
- Troubleshooting

**When to read**: When deploying to staging or production environments

---

#### [05 - API Reference](./05-api-reference.md)

**Audience**: Backend Developers, Technical Architects

Internal architecture reference:

- Guards and authentication mechanisms
- Custom decorators
- Interceptors and filters
- Controller implementations
- Service interfaces
- Data models and DTOs
- WebSocket gateway specifications
- Error codes and handling

**When to read**: When understanding internal architecture or extending functionality

---

## Quick Start Paths

### 🎯 I want to...

#### Use the API

→ Start with [Usage Guide](./03-usage-guide.md)
→ Try interactive docs at http://localhost:8868/api/v1/docs (in dev mode)

#### Develop new features

→ Read [Development Guide](./02-development-guide.md)
→ Check [Implementation Status](./01-implementation-status.md) for existing features
→ Reference [API Reference](./05-api-reference.md) for architecture details

#### Deploy to production

→ Follow [Deployment Guide](./04-deployment-guide.md)
→ Review security checklist in deployment guide
→ Set up monitoring as described

#### Understand what's available

→ Check [Implementation Status](./01-implementation-status.md)
→ Browse [API Reference](./05-api-reference.md) for technical details

---

## Documentation Conventions

### Code Examples

All code examples follow these conventions:

**TypeScript/JavaScript:**

```typescript
// Clear variable names
// Type annotations included
// Comments for complex logic
const session = await client.sessions.create({
  patientId: 'patient_123',
  sessionType: 'CONSULTATION',
});
```

**cURL:**

```bash
# Include all necessary headers
# Use readable formatting
curl -X POST https://api.hope.com/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"patientId": "patient_123"}'
```

### Environment References

- **Development**: `http://localhost:8868`
- **Staging**: `https://staging-api.hope.com`
- **Production**: `https://api.hope.com`

### Status Indicators

- ✅ **Completed**: Feature is fully implemented and tested
- 🔄 **In Progress**: Feature is currently being developed
- 🟡 **Planned**: Feature is planned for future implementation
- ❌ **Deprecated**: Feature is deprecated and should not be used

---

## Related Documentation

### Project-Level Documentation

Located in `/docs/` (project root):

- [Technical Architecture Overview](../../../technical-architecture-overview.md)
- [Backend Architecture](../../../backend-architecture.md)
- [Tech Stack](../../../tech-stack.md)
- [Project Structure](../../../project-structure.md)

### Package Documentation

- [@arcaai/applications](../../../packages/applications/README.md) - Business logic layer
- [@arcaai/domains](../../../packages/domains/README.md) - Domain models
- [@arcaai/database](../../../packages/database/README.md) - Database layer
- [@arcaai/logger](../../../packages/logger/README.md) - Logging utilities

### Service Documentation

- [STT Service](../../stt/README.md) - Speech-to-Text service
- [Text Service](../../text/README.md) - Multi-provider text generation
- [Guardrail Service](../../guardrail/README.md) - Safety/guardrail engine (port 8863)
- [NLP Service](../../nlp/README.md) - Natural Language Processing service
- [Harness Service](../../harness/README.md) - Clinical Documentation Harness (port 8866)

### Infrastructure Documentation

- [Docker Setup](../../../infrastructure/docker/README.md)
- [Single Deployment](../../../infrastructure/single-deployment/README.md)
- [Security Guide](../../../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md)

---

## Development Standards

All API Gateway development follows these standards:

### Backend Standards

- NestJS best practices
- Module organization
- Error handling patterns
- Security guidelines

### Database Standards

- Prisma schema conventions
- Migration workflows
- Data modeling principles

### API Gateway Standards

- Controller patterns
- Service implementation
- Authentication strategies
- Testing requirements

---

## Getting Help

### Internal Resources

1. **Check Documentation**: Start with the relevant guide above
2. **Review Implementation**: Check [Implementation Status](./01-implementation-status.md)
3. **Search Codebase**: Use examples from existing controllers
4. **Ask Team**: Reach out on Slack/Discord

### External Resources

- [NestJS Documentation](https://docs.nestjs.com/)
- [Prisma Documentation](https://www.prisma.io/docs/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

### Support Channels

- **GitHub Issues**: For bugs and feature requests
- **Team Chat**: For quick questions
- **Email**: support@hope.com for urgent issues

---

## Contributing to Documentation

### When to Update

Update documentation when:

- Adding new features or endpoints
- Changing existing functionality
- Fixing bugs that affect usage
- Improving deployment processes
- Adding new best practices

### How to Update

1. **Identify affected documents**: Usually implementation-status + relevant guide
2. **Make updates**: Keep examples practical and clear
3. **Update version info**: Increment version and update "Last Updated" date
4. **Test examples**: Ensure all code examples work
5. **Update cross-references**: Fix any broken links

### Documentation Standards

- **Clear Language**: Write for the intended audience
- **Working Examples**: All code examples must be tested
- **Current Information**: Keep URLs and references up to date
- **Consistent Formatting**: Follow existing structure and style
- **Version Tracking**: Update version info in each document

---

## Document Versions

| Document                                               | Version | Last Updated | Maintained By |
| ------------------------------------------------------ | ------- | ------------ | ------------- |
| [README](../README.md)                                 | 1.0     | 2025-01-10   | HOPE Team     |
| [Implementation Status](./01-implementation-status.md) | 1.0     | 2025-01-10   | Dev Team      |
| [Development Guide](./02-development-guide.md)         | 1.0     | 2025-01-10   | Dev Team      |
| [Usage Guide](./03-usage-guide.md)                     | 1.0     | 2025-01-10   | Dev Team      |
| [Deployment Guide](./04-deployment-guide.md)           | 1.0     | 2025-01-10   | DevOps Team   |
| [API Reference](./05-api-reference.md)                 | 1.0     | 2025-01-10   | Dev Team      |

---

## Feedback

Found an issue or have a suggestion for improving the documentation?

- **Create an Issue**: Use the project issue tracker
- **Submit a PR**: Propose documentation improvements
- **Contact Team**: Reach out to documentation maintainers

---

**Last Updated**: 2025-01-10
**Documentation Version**: 1.0
**Maintained By**: HOPE Development Team
