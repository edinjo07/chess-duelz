// KYC Routes - Document Upload and Verification System
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/kyc');
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: userId_timestamp_random.ext
    const userId = req.user.userId;
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${userId}_${timestamp}_${random}${ext}`);
  }
});

// File filter - only allow images and PDFs
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, WebP and PDF files are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max file size
  }
});

// Helper function to log KYC actions
function logKYCAction(db, userId, action, metadata = {}) {
  const { documentId, adminId, oldStatus, newStatus, reason, ipAddress } = metadata;
  
  db.query(
    `INSERT INTO kyc_verification_log (user_id, action, document_id, admin_id, old_status, new_status, reason, metadata, ip_address) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, action, documentId || null, adminId || null, oldStatus || null, newStatus || null, reason || null, 
     JSON.stringify(metadata), ipAddress || null],
    (err) => {
      if (err) console.error('Error logging KYC action:', err);
    }
  );
}

// Get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress;
}

module.exports = (db, verifyToken, verifyAdminToken) => {
  
  // ==================== USER ENDPOINTS ====================
  
  // Get KYC status for current user
  router.get('/status', verifyToken, (req, res) => {
    const userId = req.user.userId;
    
    // First check if user exists
    db.query('SELECT id FROM users WHERE id = ?', [userId], (err, results) => {
      if (err) {
        console.error('Error fetching user:', err);
        return res.status(500).json({ error: 'Failed to fetch user', details: err.message });
      }
      
      if (results.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Check for uploaded documents to determine status
      db.query(`
        SELECT document_type, status, uploaded_at
        FROM kyc_documents
        WHERE user_id = ?
        ORDER BY uploaded_at DESC
      `, [userId], (docErr, documents) => {
        if (docErr) {
          console.error('Error fetching KYC documents:', docErr);
          // Return default status if kyc_documents table doesn't exist
          return res.json({
            kyc_status: 'not_started',
            kyc_submitted_at: null,
            kyc_approved_at: null,
            proof_of_id_status: 'not_submitted',
            proof_of_address_status: 'not_submitted'
          });
        }
        
        // Determine overall status based on documents
        let overallStatus = 'not_started';
        let idStatus = 'not_submitted';
        let addressStatus = 'not_submitted';
        
        if (documents.length > 0) {
          overallStatus = 'pending';
          const idDocs = documents.filter(d => d.document_type === 'proof_of_id');
          const addressDocs = documents.filter(d => d.document_type === 'proof_of_address');
          
          if (idDocs.length > 0) {
            idStatus = idDocs[0].status || 'pending';
          }
          if (addressDocs.length > 0) {
            addressStatus = addressDocs[0].status || 'pending';
          }
          
          // If all approved, set overall status to verified
          if (idStatus === 'approved' && addressStatus === 'approved') {
            overallStatus = 'verified';
          } else if (idStatus === 'rejected' || addressStatus === 'rejected') {
            overallStatus = 'rejected';
          }
        }
        
        res.json({
          kyc_status: overallStatus,
          kyc_submitted_at: documents.length > 0 ? documents[0].uploaded_at : null,
          kyc_approved_at: overallStatus === 'verified' ? new Date() : null,
          proof_of_id_status: idStatus,
          proof_of_address_status: addressStatus
        });
      });
    });
  });
  
  // Get user's uploaded documents
  router.get('/documents', verifyToken, (req, res) => {
    const userId = req.user.userId;
    
    // First check if table exists
    db.query(`SHOW TABLES LIKE 'kyc_documents'`, (err, tables) => {
      if (err || tables.length === 0) {
        console.log('kyc_documents table does not exist, returning empty array');
        return res.json({ documents: [] });
      }
      
      db.query(`
        SELECT id, document_type, document_subtype, document_side, file_name, file_size, 
               mime_type, status, rejection_reason, uploaded_at, reviewed_at
        FROM kyc_documents
        WHERE user_id = ?
        ORDER BY uploaded_at DESC
      `, [userId], (err, results) => {
        if (err) {
          console.error('Error fetching documents:', err);
          return res.json({ documents: [] }); // Return empty array on error
        }
        
        res.json({ documents: results });
      });
    });
  });
  
  // Upload KYC document
  router.post('/upload', verifyToken, upload.single('document'), (req, res) => {
    const userId = req.user.userId;
    const { documentType, documentSubtype, documentSide } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    if (!documentType || !['proof_of_id', 'proof_of_address', 'other'].includes(documentType)) {
      // Delete uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid document type' });
    }

    // Validate document side for ID/DL
    const requiresBothSides = documentSubtype === 'drivers_license' || documentSubtype === 'national_id';
    if (requiresBothSides && (!documentSide || !['front', 'back'].includes(documentSide))) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Document side (front/back) is required for ID and driver\'s license' });
    }
    
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const fileSize = req.file.size;
    const mimeType = req.file.mimetype;
    const side = documentSide || 'single';
    
    // Insert document record
    db.query(`
      INSERT INTO kyc_documents (user_id, document_type, document_subtype, document_side, file_path, file_name, file_size, mime_type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `, [userId, documentType, documentSubtype, side, filePath, fileName, fileSize, mimeType], (err, result) => {
      if (err) {
        console.error('Error saving document:', err);
        fs.unlinkSync(req.file.path); // Delete file if DB insert fails
        return res.status(500).json({ error: 'Failed to save document' });
      }
      
      const documentId = result.insertId;
      
      // Update or create KYC status record
      db.query(`
        INSERT INTO kyc_status (user_id, overall_status, ${documentType}_status, submission_date)
        VALUES (?, 'pending', 'pending', NOW())
        ON DUPLICATE KEY UPDATE 
          ${documentType}_status = 'pending',
          overall_status = CASE 
            WHEN overall_status = 'not_started' THEN 'pending'
            ELSE overall_status
          END,
          submission_date = COALESCE(submission_date, NOW()),
          updated_at = NOW()
      `, [userId], (err) => {
        if (err) {
          console.error('Error updating KYC status:', err);
        }
      });
      
      // Update user's KYC status
      db.query(`
        UPDATE users 
        SET kyc_status = 'pending', kyc_submitted_at = COALESCE(kyc_submitted_at, NOW())
        WHERE id = ? AND kyc_status = 'not_started'
      `, [userId]);
      
      // Log action
      logKYCAction(db, userId, 'document_uploaded', {
        documentId: documentId,
        documentType: documentType,
        documentSubtype: documentSubtype,
        documentSide: side,
        fileName: fileName,
        ipAddress: getClientIP(req)
      });
      
      res.json({
        success: true,
        message: 'Document uploaded successfully',
        document: {
          id: documentId,
          document_type: documentType,
          document_subtype: documentSubtype,
          document_side: side,
          file_name: fileName,
          status: 'pending',
          uploaded_at: new Date()
        }
      });
    });
  });
  
  // Delete user's own document (only if pending)
  router.delete('/documents/:id', verifyToken, (req, res) => {
    const userId = req.user.userId;
    const documentId = req.params.id;
    
    // Get document info first
    db.query(`
      SELECT file_path, status FROM kyc_documents 
      WHERE id = ? AND user_id = ?
    `, [documentId, userId], (err, results) => {
      if (err) {
        console.error('Error fetching document:', err);
        return res.status(500).json({ error: 'Failed to fetch document' });
      }
      
      if (results.length === 0) {
        return res.status(404).json({ error: 'Document not found' });
      }
      
      const document = results[0];
      
      // Only allow deletion of pending documents
      if (document.status !== 'pending') {
        return res.status(403).json({ error: 'Cannot delete reviewed documents' });
      }
      
      // Delete file from filesystem
      if (fs.existsSync(document.file_path)) {
        fs.unlinkSync(document.file_path);
      }
      
      // Delete from database
      db.query('DELETE FROM kyc_documents WHERE id = ?', [documentId], (err) => {
        if (err) {
          console.error('Error deleting document:', err);
          return res.status(500).json({ error: 'Failed to delete document' });
        }
        
        res.json({ success: true, message: 'Document deleted successfully' });
      });
    });
  });
  
  // ==================== ADMIN ENDPOINTS ====================
  
  // Admin middleware
  function requireAdmin(req, res, next) {
    db.query('SELECT is_admin FROM users WHERE id = ?', [req.user.userId], (err, results) => {
      if (err || results.length === 0 || !results[0].is_admin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    });
  }
  
  // Get all pending KYC submissions (Admin only)
  router.get('/admin/pending', verifyAdminToken, (req, res) => {
    // First check if kyc tables exist
    db.query(`SHOW TABLES LIKE 'kyc_documents'`, (tableErr, tables) => {
      if (tableErr || tables.length === 0) {
        // Tables don't exist yet
        return res.json({ 
          submissions: [], 
          message: 'KYC system not yet initialized. No submissions available.' 
        });
      }

      // Query for pending submissions - using only kyc_documents table
      db.query(`
        SELECT DISTINCT
          kd.user_id,
          u.username,
          u.email,
          COUNT(DISTINCT kd.id) as document_count,
          MAX(kd.uploaded_at) as last_upload,
          GROUP_CONCAT(DISTINCT kd.document_type) as document_types
        FROM kyc_documents kd
        JOIN users u ON kd.user_id = u.id
        WHERE kd.status = 'pending'
        GROUP BY kd.user_id
        ORDER BY MAX(kd.uploaded_at) DESC
      `, (err, results) => {
        if (err) {
          console.error('Error fetching pending KYC:', err);
          console.error('Error code:', err.code);
          console.error('Error message:', err.message);
          
          return res.status(500).json({ 
            error: 'Failed to fetch pending KYC submissions',
            details: err.message
          });
        }
        
        res.json({ submissions: results || [] });
      });
    });
  });
  
  // Get all KYC submissions with filters (Admin only)
  router.get('/admin/all', verifyAdminToken, (req, res) => {
    const { status, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT DISTINCT
        u.id as user_id,
        u.username,
        u.email,
        u.kyc_status,
        u.kyc_submitted_at,
        u.kyc_approved_at,
        ks.proof_of_id_status,
        ks.proof_of_address_status,
        ks.rejection_reason,
        COUNT(DISTINCT kd.id) as document_count,
        MAX(kd.uploaded_at) as last_upload
      FROM users u
      LEFT JOIN kyc_status ks ON u.id = ks.user_id
      LEFT JOIN kyc_documents kd ON u.id = kd.user_id
      WHERE u.kyc_status != 'not_started'
    `;
    
    const params = [];
    
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query += ' AND u.kyc_status = ?';
      params.push(status);
    }
    
    query += ' GROUP BY u.id ORDER BY MAX(kd.uploaded_at) DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    db.query(query, params, (err, results) => {
      if (err) {
        console.error('Error fetching KYC submissions:', err);
        return res.status(500).json({ error: 'Failed to fetch KYC submissions' });
      }
      
      res.json({ submissions: results });
    });
  });
  
  // Get specific user's KYC details (Admin only)
  router.get('/admin/user/:userId', verifyAdminToken, (req, res) => {
    const userId = req.params.userId;
    
    // Get user info and KYC status
    db.query(`
      SELECT 
        u.id, u.username, u.email, u.first_name, u.last_name,
        u.date_of_birth, u.phone, u.address_line1, u.address_line2,
        u.city, u.state_province, u.postal_code, u.country, u.nationality,
        u.kyc_status, u.kyc_submitted_at, u.kyc_approved_at,
        ks.proof_of_id_status, ks.proof_of_address_status,
        ks.submission_date, ks.approval_date, ks.rejection_date,
        ks.rejection_reason, ks.notes
      FROM users u
      LEFT JOIN kyc_status ks ON u.id = ks.user_id
      WHERE u.id = ?
    `, [userId], (err, userResults) => {
      if (err) {
        console.error('Error fetching user KYC details:', err);
        return res.status(500).json({ error: 'Failed to fetch user details' });
      }
      
      if (userResults.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Get user's documents
      db.query(`
        SELECT id, document_type, document_subtype, file_name, file_size,
               mime_type, status, rejection_reason, uploaded_at, reviewed_at, reviewed_by
        FROM kyc_documents
        WHERE user_id = ?
        ORDER BY uploaded_at DESC
      `, [userId], (err, documents) => {
        if (err) {
          console.error('Error fetching documents:', err);
          return res.status(500).json({ error: 'Failed to fetch documents' });
        }
        
        // Get verification log
        db.query(`
          SELECT l.*, a.username as admin_username
          FROM kyc_verification_log l
          LEFT JOIN users a ON l.admin_id = a.id
          WHERE l.user_id = ?
          ORDER BY l.created_at DESC
          LIMIT 20
        `, [userId], (err, logs) => {
          if (err) {
            console.error('Error fetching logs:', err);
            return res.status(500).json({ error: 'Failed to fetch logs' });
          }
          
          res.json({
            user: userResults[0],
            documents: documents,
            logs: logs
          });
        });
      });
    });
  });
  
  // View/Download document (Admin only)
  router.get('/admin/document/:documentId', verifyAdminToken, (req, res) => {
    const documentId = req.params.documentId;
    
    db.query(`
      SELECT file_path, file_name, mime_type 
      FROM kyc_documents 
      WHERE id = ?
    `, [documentId], (err, results) => {
      if (err) {
        console.error('Error fetching document:', err);
        return res.status(500).json({ error: 'Failed to fetch document' });
      }
      
      if (results.length === 0) {
        return res.status(404).json({ error: 'Document not found' });
      }
      
      const document = results[0];
      
      if (!fs.existsSync(document.file_path)) {
        return res.status(404).json({ error: 'File not found on server' });
      }
      
      res.setHeader('Content-Type', document.mime_type);
      res.setHeader('Content-Disposition', `inline; filename="${document.file_name}"`);
      res.sendFile(path.resolve(document.file_path));
    });
  });
  
  // Approve specific document (Admin only)
  router.post('/admin/document/:documentId/approve', verifyAdminToken, (req, res) => {
    const documentId = req.params.documentId;
    const adminId = req.user.userId;
    
    // Get document details
    db.query('SELECT user_id, document_type, status FROM kyc_documents WHERE id = ?', [documentId], (err, results) => {
      if (err || results.length === 0) {
        return res.status(404).json({ error: 'Document not found' });
      }
      
      const { user_id, document_type, status: oldStatus } = results[0];
      
      // Update document status
      db.query(`
        UPDATE kyc_documents 
        SET status = 'approved', reviewed_by = ?, reviewed_at = NOW()
        WHERE id = ?
      `, [adminId, documentId], (err) => {
        if (err) {
          console.error('Error approving document:', err);
          return res.status(500).json({ error: 'Failed to approve document' });
        }
        
        // Update KYC status table
        db.query(`
          UPDATE kyc_status 
          SET ${document_type}_status = 'approved', updated_at = NOW()
          WHERE user_id = ?
        `, [user_id], (err) => {
          if (err) console.error('Error updating KYC status:', err);
        });
        
        // Check if all required documents are approved
        db.query(`
          SELECT proof_of_id_status, proof_of_address_status 
          FROM kyc_status 
          WHERE user_id = ?
        `, [user_id], (err, statusResults) => {
          if (err) {
            console.error('Error checking KYC status:', err);
          } else if (statusResults.length > 0) {
            const { proof_of_id_status, proof_of_address_status } = statusResults[0];
            
            // If both required documents are approved, approve the user
            if (proof_of_id_status === 'approved' && proof_of_address_status === 'approved') {
              db.query(`
                UPDATE users 
                SET kyc_status = 'approved', kyc_approved_at = NOW()
                WHERE id = ?
              `, [user_id]);
              
              db.query(`
                UPDATE kyc_status 
                SET overall_status = 'approved', approval_date = NOW()
                WHERE user_id = ?
              `, [user_id]);
              
              logKYCAction(db, user_id, 'status_changed', {
                adminId: adminId,
                oldStatus: 'pending',
                newStatus: 'approved',
                ipAddress: getClientIP(req)
              });
            }
          }
        });
        
        // Log action
        logKYCAction(db, user_id, 'document_approved', {
          documentId: documentId,
          adminId: adminId,
          documentType: document_type,
          oldStatus: oldStatus,
          newStatus: 'approved',
          ipAddress: getClientIP(req)
        });
        
        res.json({ success: true, message: 'Document approved successfully' });
      });
    });
  });
  
  // Reject specific document (Admin only)
  router.post('/admin/document/:documentId/reject', verifyAdminToken, (req, res) => {
    const documentId = req.params.documentId;
    const adminId = req.user.userId;
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }
    
    // Get document details
    db.query('SELECT user_id, document_type, status FROM kyc_documents WHERE id = ?', [documentId], (err, results) => {
      if (err || results.length === 0) {
        return res.status(404).json({ error: 'Document not found' });
      }
      
      const { user_id, document_type, status: oldStatus } = results[0];
      
      // Update document status
      db.query(`
        UPDATE kyc_documents 
        SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ?
        WHERE id = ?
      `, [adminId, reason, documentId], (err) => {
        if (err) {
          console.error('Error rejecting document:', err);
          return res.status(500).json({ error: 'Failed to reject document' });
        }
        
        // Update KYC status table
        db.query(`
          UPDATE kyc_status 
          SET ${document_type}_status = 'rejected', updated_at = NOW()
          WHERE user_id = ?
        `, [user_id], (err) => {
          if (err) console.error('Error updating KYC status:', err);
        });
        
        // Update user's overall KYC status to rejected
        db.query(`
          UPDATE users 
          SET kyc_status = 'rejected'
          WHERE id = ?
        `, [user_id]);
        
        db.query(`
          UPDATE kyc_status 
          SET overall_status = 'rejected', rejection_date = NOW(), rejection_reason = ?
          WHERE user_id = ?
        `, [reason, user_id]);
        
        // Log action
        logKYCAction(db, user_id, 'document_rejected', {
          documentId: documentId,
          adminId: adminId,
          documentType: document_type,
          oldStatus: oldStatus,
          newStatus: 'rejected',
          reason: reason,
          ipAddress: getClientIP(req)
        });
        
        res.json({ success: true, message: 'Document rejected successfully' });
      });
    });
  });
  
  // Approve entire KYC submission (Admin only)
  router.post('/admin/user/:userId/approve', verifyAdminToken, (req, res) => {
    const userId = req.params.userId;
    const adminId = req.user.userId;
    const { notes } = req.body;
    
    db.query(`
      UPDATE users 
      SET kyc_status = 'approved', kyc_approved_at = NOW()
      WHERE id = ?
    `, [userId], (err) => {
      if (err) {
        console.error('Error approving KYC:', err);
        return res.status(500).json({ error: 'Failed to approve KYC' });
      }
      
      db.query(`
        UPDATE kyc_status 
        SET overall_status = 'approved', 
            proof_of_id_status = 'approved',
            proof_of_address_status = 'approved',
            approval_date = NOW(),
            notes = ?
        WHERE user_id = ?
      `, [notes || null, userId], (err) => {
        if (err) console.error('Error updating KYC status:', err);
      });
      
      // Approve all pending documents
      db.query(`
        UPDATE kyc_documents 
        SET status = 'approved', reviewed_by = ?, reviewed_at = NOW()
        WHERE user_id = ? AND status = 'pending'
      `, [adminId, userId]);
      
      // Log action
      logKYCAction(db, userId, 'status_changed', {
        adminId: adminId,
        oldStatus: 'pending',
        newStatus: 'approved',
        reason: notes,
        ipAddress: getClientIP(req)
      });
      
      res.json({ success: true, message: 'KYC approved successfully' });
    });
  });
  
  // Reject entire KYC submission (Admin only)
  router.post('/admin/user/:userId/reject', verifyAdminToken, (req, res) => {
    const userId = req.params.userId;
    const adminId = req.user.userId;
    const { reason, notes } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }
    
    db.query(`
      UPDATE users 
      SET kyc_status = 'rejected'
      WHERE id = ?
    `, [userId], (err) => {
      if (err) {
        console.error('Error rejecting KYC:', err);
        return res.status(500).json({ error: 'Failed to reject KYC' });
      }
      
      db.query(`
        UPDATE kyc_status 
        SET overall_status = 'rejected',
            rejection_date = NOW(),
            rejection_reason = ?,
            notes = ?
        WHERE user_id = ?
      `, [reason, notes || null, userId], (err) => {
        if (err) console.error('Error updating KYC status:', err);
      });
      
      // Reject all pending documents
      db.query(`
        UPDATE kyc_documents 
        SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ?
        WHERE user_id = ? AND status = 'pending'
      `, [adminId, reason, userId]);
      
      // Log action
      logKYCAction(db, userId, 'status_changed', {
        adminId: adminId,
        oldStatus: 'pending',
        newStatus: 'rejected',
        reason: reason,
        ipAddress: getClientIP(req)
      });
      
      res.json({ success: true, message: 'KYC rejected successfully' });
    });
  });
  
  // Add admin notes (Admin only)
  router.post('/admin/user/:userId/notes', verifyAdminToken, (req, res) => {
    const userId = req.params.userId;
    const adminId = req.user.userId;
    const { notes } = req.body;
    
    if (!notes) {
      return res.status(400).json({ error: 'Notes are required' });
    }
    
    db.query(`
      UPDATE kyc_status 
      SET notes = ?, updated_at = NOW()
      WHERE user_id = ?
    `, [notes, userId], (err) => {
      if (err) {
        console.error('Error adding notes:', err);
        return res.status(500).json({ error: 'Failed to add notes' });
      }
      
      // Log action
      logKYCAction(db, userId, 'admin_note_added', {
        adminId: adminId,
        reason: notes,
        ipAddress: getClientIP(req)
      });
      
      res.json({ success: true, message: 'Notes added successfully' });
    });
  });
  
  return router;
};
