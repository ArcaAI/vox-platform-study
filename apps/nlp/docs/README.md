# NLP Service Documentation

Welcome to the HOPE NLP Service documentation. This directory contains comprehensive guides for using, developing, and deploying the NLP service.

## Documentation Structure

### Core Documentation

1. **[Architecture Overview](01-architecture.md)** - System architecture and design patterns
   - High-level architecture
   - Layer-by-layer design
   - Design patterns used
   - Data flow diagrams
   - Concurrency model
   - Error handling
   - Performance considerations

2. **[API Reference](02-api-reference.md)** - Complete API documentation
   - REST API endpoints
   - WebSocket endpoints
   - Request/response formats
   - Error responses
   - Code examples
   - Client SDKs

3. **[Model Documentation](03-models.md)** - ML models and capabilities
   - Text classification model
   - Token classification (NER) model
   - Medical diagnosis suggester
   - Text correction system
   - Model performance metrics
   - GPU acceleration guide

4. **[Development Guide](04-development-guide.md)** - Developer documentation
   - Environment setup
   - Project structure
   - Development workflow
   - Coding standards
   - Testing guidelines
   - Debugging tips

5. **[Configuration Guide](05-configuration.md)** - Configuration options
   - Environment variables
   - Service configuration
   - Model configuration
   - Security settings
   - Performance tuning

6. **[Deployment Guide](06-deployment.md)** - Production deployment
   - Docker deployment
   - Kubernetes deployment
   - Single-server deployment
   - Monitoring setup
   - Scaling strategies

## Quick Links

### Getting Started

- [Quick Start](../README.md#-quick-start)
- [Installation](04-development-guide.md#development-environment-setup)
- [First API Call](02-api-reference.md#text-classification)

### Common Tasks

- [Running the Service](../README.md#local-development)
- [Making API Requests](02-api-reference.md#rest-api-endpoints)
- [Adding a New Endpoint](04-development-guide.md#adding-a-new-endpoint)
- [Deploying to Production](06-deployment.md#production-checklist)

### Reference

- [Environment Variables](05-configuration.md#environment-variables)
- [API Endpoints](02-api-reference.md#api-endpoints)
- [Model Details](03-models.md#overview)
- [Troubleshooting](../README.md#-troubleshooting)

## Documentation Conventions

### Code Examples

All code examples are provided in multiple formats where applicable:

**curl:**
```bash
curl -X POST http://localhost:8864/api/v1/classify/text \
  -H "Content-Type: application/json" \
  -d '{"text": "Patient is happy", "language": "en"}'
```

**Python:**
```python
import requests

response = requests.post(
    "http://localhost:8864/api/v1/classify/text",
    json={"text": "Patient is happy", "language": "en"}
)
```

**JavaScript:**
```javascript
const response = await fetch('http://localhost:8864/api/v1/classify/text', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({text: 'Patient is happy', language: 'en'})
});
```

### Symbols

- ✅ Feature available
- ⚠️ Important warning
- 📝 Note or tip
- 🔒 Security-related
- 🚀 Performance-related

## Support

### Documentation Issues

If you find any issues with the documentation:
1. Check if the information is outdated
2. Verify against the actual codebase
3. Open an issue or submit a PR
4. Contact the documentation team

### Technical Support

For technical support:
1. Check the [troubleshooting guide](../README.md#-troubleshooting)
2. Review the [FAQ](04-development-guide.md#troubleshooting)
3. Search existing issues
4. Open a new issue with details
5. Contact the development team

## Contributing to Documentation

We welcome contributions to improve the documentation!

### Documentation Standards

- Use Markdown format
- Include code examples
- Add diagrams where helpful
- Keep language clear and concise
- Test all code examples
- Update table of contents

### Making Changes

1. Fork the repository
2. Create a documentation branch
3. Make your changes
4. Test all examples
5. Submit a pull request
6. Address review feedback

### Documentation Review

All documentation changes go through:
1. Technical accuracy review
2. Grammar and style review
3. Code example testing
4. Cross-reference verification

## Version History

- **v0.1.0** (2025-01) - Initial documentation
  - Architecture overview
  - API reference
  - Model documentation
  - Development guide
  - Configuration guide
  - Deployment guide

## Feedback

We value your feedback on our documentation!

- **Clarity**: Is the documentation easy to understand?
- **Completeness**: Is anything missing?
- **Accuracy**: Is the information correct?
- **Examples**: Are the examples helpful?

Please share your feedback by:
- Opening an issue
- Contacting the team
- Submitting improvements

## Additional Resources

### External Resources

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Transformers Documentation](https://huggingface.co/docs/transformers)
- [PyTorch Documentation](https://pytorch.org/docs/)
- [Pydantic Documentation](https://docs.pydantic.dev/)
- [Docker Documentation](https://docs.docker.com/)

### Project Resources

- [Main Project README](../README.md)
- [Project Architecture](../../docs/technical-architecture-overview.md)
- [API Gateway Documentation](../../apps/api/README.md)
- [Infrastructure Documentation](../../infrastructure/README.md)

### Community

- GitHub Discussions
- Development Team Chat
- Issue Tracker
- Pull Requests

---

**Last Updated:** January 2025
**Documentation Version:** 1.0.0
**Service Version:** 0.1.0

