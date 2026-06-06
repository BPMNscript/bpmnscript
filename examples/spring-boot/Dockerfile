# Stage 1 — Build
# Uses the official Maven image with Eclipse Temurin JDK 17.
FROM maven:3.9-eclipse-temurin-17 AS build

WORKDIR /workspace

# Copy pom.xml first to cache the dependency download layer separately from source.
COPY pom.xml .
RUN mvn dependency:go-offline --no-transfer-progress

# Copy source and package, skipping tests (tests are run via testcontainers, not inside the image).
COPY src ./src
RUN mvn package -DskipTests --no-transfer-progress

# Stage 2 — Runtime
# Lean JRE-only image; the fat jar carries everything it needs.
FROM eclipse-temurin:17-jre

WORKDIR /app

COPY --from=build /workspace/target/*.jar /app/app.jar

EXPOSE 8080

# Healthcheck: testcontainers wait strategy polls this endpoint.
# The engine REST API returns 200 with a JSON array of engine names once Operaton is ready.
HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=12 \
  CMD wget -qO- http://localhost:8080/engine-rest/engine || exit 1

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
