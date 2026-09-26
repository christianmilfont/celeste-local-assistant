# Setup script for .env file
Write-Host "Creating .env file from .env.example..."

if (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Write-Host ".env file created successfully!"
    Write-Host "Please edit .env file with your configuration."
} else {
    Write-Host "Error: .env.example not found!"
}
