FROM python:3.11-slim-buster

# Install python package
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Create mlflow user and directory
RUN useradd -m -s /bin/bash mlflow
USER mlflow
WORKDIR /home/mlflow

# Expose MLflow port
EXPOSE 5000

# Set default command
CMD ["mlflow", "server", "--host", "0.0.0.0", "--port", "5000"]