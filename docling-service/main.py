import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile

try:
    from docling.document_converter import DocumentConverter

    DOCLING_READY = True
except Exception:
    DocumentConverter = None
    DOCLING_READY = False

app = FastAPI(title="ChronoPact Docling Service", version="1.0.0")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "chronopact-docling",
        "doclingReady": DOCLING_READY,
    }


@app.post("/parse")
async def parse_document(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="A filename is required")

    extension = Path(file.filename).suffix.lower()
    if extension not in {".pdf", ".docx", ".txt"}:
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type. Only PDF, DOCX, and TXT files are accepted.",
        )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded document is empty")

    if extension == ".txt":
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=400, detail="TXT documents must use UTF-8 encoding") from exc
        if not text.strip():
            raise HTTPException(status_code=400, detail="The uploaded document is empty")
        return {
            "filename": file.filename,
            "markdownText": text,
            "characterCount": len(text),
        }

    if not DOCLING_READY:
        raise HTTPException(status_code=503, detail="Docling is not installed or could not be initialized")

    temp_path = None
    try:
        suffix = extension
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
            temp.write(content)
            temp_path = temp.name

        result = DocumentConverter().convert(temp_path)
        markdown = result.document.export_to_markdown()
        if not markdown or not markdown.strip():
            raise HTTPException(status_code=422, detail="Docling extracted no text from the document")

        return {
            "filename": file.filename,
            "markdownText": markdown,
            "characterCount": len(markdown),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Document extraction failed: {exc}") from exc
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass
